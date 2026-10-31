import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { publishAgentDeletionJournalStatus } from "../state/agent-deletion-journal-status.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  observeMainThreadSql,
  expectNoMainThreadSql as withoutHostSql,
} from "../test-utils/main-thread-sql-spies.test-support.js";
import { createExecApprovalPolicySnapshot } from "./exec-approvals-allow-always.js";
import { commitExecAuthorizationLocked } from "./exec-approvals-authorization.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { prepareCronExecHostPolicyUse } from "./exec-approvals-cron-policy.js";
import { currentPolicyExec } from "./exec-approvals-current-policy.test-support.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
} from "./exec-approvals-migration-gate.js";
import {
  execApprovalsPublication,
  type ExecApprovalsPublicationValue,
} from "./exec-approvals-publication.js";
import * as execApprovalsSocket from "./exec-approvals-socket.js";
import { serializeExecApprovals, writeExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import {
  commitExecAuthorizations,
  ensureExecApprovalsSnapshot,
  loadExecApprovals,
  loadExecApprovalsReadOnly,
  loadExecApprovalsReadOnlyAsync,
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshotLocked,
  updateExecApprovals,
  withAgentExecApprovalsRemoved,
} from "./exec-approvals-store.js";
import {
  saveExecApprovals,
  testing as execApprovalsStoreTesting,
} from "./exec-approvals-store.test-support.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as workerProbe } from "./sqlite-worker-owner-probe.test-support.js";

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: (name: string) => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: name === "infra/exec-approvals" ? loggerWarn : vi.fn(),
    error: vi.fn(),
  }),
}));

const tempDirs = createTempDirTracker();
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

function row() {
  const db = openOpenClawStateDatabase().db;
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "exec_approvals_config">>(db)
      .selectFrom("exec_approvals_config")
      .selectAll()
      .where("config_key", "=", "current"),
  );
}

function fixturePath(name: string) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert(stateDir, "missing test state dir");
  return path.join(stateDir, name);
}

function makeStateDatabaseUnavailable(): void {
  closeOpenClawStateDatabaseForTest();
  fs.writeFileSync(fixturePath("state"), "not a directory");
}

async function withDeletion<T>(
  agentId: string,
  run: (deletion: AgentDeletionOperation) => Promise<T>,
): Promise<T> {
  return withAgentDeletion(agentId, async (begin) =>
    run(
      await begin({
        agentId: normalizeAgentId(agentId),
        agentDir: "/agent",
        workspaceDir: "/workspace",
        sessionsDir: "/sessions",
      }),
    ),
  );
}

async function removeAgentPolicies<T>(agentId: string, commit: () => Promise<T>): Promise<T> {
  return withDeletion(agentId, (deletion) =>
    withAgentExecApprovalsRemoved(agentId, commit, deletion),
  );
}

function authorizeEcho(command = "echo before") {
  const entry = { id: "echo", pattern: "/usr/bin/echo" };
  saveExecApprovals({ version: 1, agents: { main: { allowlist: [entry] } } });
  return { ...currentPolicyExec(command), matches: [entry] };
}

function policy(
  defaults: ExecApprovalsFile["defaults"],
  agents: ExecApprovalsFile["agents"] = {},
): ExecApprovalsFile {
  return { version: 1, defaults, agents };
}

async function withForeignDatabase<T>(run: (db: DatabaseSync) => T | Promise<T>) {
  const db = new DatabaseSync(resolveOpenClawStateSqlitePath());
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

function replacePolicy(
  file: ExecApprovalsFile,
  options: Omit<Parameters<typeof updateExecApprovals>[0], "update"> & {
    preserveSocket?: boolean;
  } = {},
) {
  const { preserveSocket, ...rest } = options;
  return updateExecApprovals({ ...rest, update: { kind: "replace", file, preserveSocket } });
}

async function pauseDeletion(agentId: string) {
  const started = createDeferred();
  const gate = createDeferred();
  const deletion = removeAgentPolicies(agentId, async () => {
    started.resolve();
    await gate.promise;
    return "committed";
  });
  await awaitGateBeforeSettlement(
    started.promise,
    deletion,
    "Deletion settled before roster commit",
  );
  return { deletion, finish: gate.resolve };
}

beforeEach(() => {
  setTestEnvValue("OPENCLAW_STATE_DIR", tempDirs.make("exec-approvals-db-"));
  loggerWarn.mockReset();
  execApprovalsStoreTesting.reset();
});

afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
  execApprovalsStoreTesting.reset();
  envSnapshot.restore();
  tempDirs.cleanup();
});

const readOnlyLoaders = [
  { name: "synchronous", load: loadExecApprovalsReadOnly },
  { name: "asynchronous", load: loadExecApprovalsReadOnlyAsync },
];

describe("exec approvals SQLite store", () => {
  it.each(readOnlyLoaders)(
    "does not create shared state for a $name read-only load",
    async ({ load }) => {
      const statePath = resolveOpenClawStateSqlitePath();
      expect(fs.existsSync(statePath)).toBe(false);

      expect(await load()).toMatchObject({ version: 1, agents: {} });
      expect(fs.existsSync(statePath)).toBe(false);
    },
  );

  it("fails closed for an unavailable synchronous read-only owner", () => {
    makeStateDatabaseUnavailable();
    expect(loadExecApprovalsReadOnly().defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed writes fail-closed instead of discarding invalid policy fields", async () => {
    const file = {
      version: 1,
      defaults: { ask: "always" },
      agents: { runner: { ask: "invalid" } },
    } as unknown as ExecApprovalsFile;
    const written = await replacePolicy(file);
    expect(written?.file.defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(written?.raw).toBe(serializeExecApprovals(file));
    expect(readExecApprovalsSnapshot().raw).toBe(serializeExecApprovals(file));
    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
    expect((await loadExecApprovalsReadOnlyAsync()).defaults).toMatchObject({
      security: "deny",
      ask: "off",
    });
  });

  it("shares the policy publication and rolls back replacement when authority ends before commit", async () => {
    const before = await ensureExecApprovalsSnapshot();
    const unknown = vi.fn();
    const release = execApprovalsPublication.subscribeFacts((change) => {
      if (change.kind === "unknown") {
        unknown();
      }
    });
    try {
      let current = true;
      let prepared: Record<string, unknown> | undefined;
      workerProbe.admission(workerAdmission, (request, grant, admit) => {
        if (request.stage === "commit") {
          assert(isRecord(request.facts));
          prepared = request.facts;
          current = false;
        }
        admit(request, grant);
      });
      await expect(
        updateExecApprovals({
          baseHash: before.hash,
          assertCurrent: () => {
            if (!current) {
              throw new Error("request authority ended");
            }
          },
          update: { kind: "replace", file: { ...before.file, defaults: { security: "deny" } } },
        }),
      ).rejects.toThrow("request authority ended");
      assert(prepared);
      const fact = execApprovalsPublication.readReceipt(prepared.execFacts).facts.get("current");
      expect(fact?.kind === "postimage" && fact.value.file).toBe(prepared.file);
      expect(readExecApprovalsSnapshot().hash).toBe(before.hash);
      expect(unknown).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("keeps credentials local and canonical approval polls off the writer", async () => {
    const initialized = await ensureExecApprovalsSnapshot();
    const first = initialized.file;
    const policyRow = row();
    const probe = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
    for (let poll = 0; poll < 18; poll++) {
      await ensureExecApprovalsSnapshot();
    }
    expect(probe).not.toHaveBeenCalled();
    const repeated = await ensureExecApprovalsSnapshot();
    const second = repeated.file;
    expect(row()).toEqual(policyRow);
    expect(repeated.hash).toBe(initialized.hash);
    expect(first.socket?.token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.socket?.token).toBe(second.socket?.token);
    expect(first.socket?.path).toBe(second.socket?.path);
    expect(row()).toMatchObject({ has_socket_token: 0, socket_path: null });
    expect(row()?.raw_json).not.toContain(first.socket?.token);
    expect(readExecApprovalsSnapshot().file.socket?.token).toBeUndefined();
    const token = "synthetic-rotated-socket-token";
    const rotated = await replacePolicy(
      { ...first, socket: { ...first.socket, token } },
      { baseHash: initialized.hash, preserveSocket: true },
    );
    expect(rotated?.file.socket?.token).toBe(token);
    expect(rotated?.hash).toBe(initialized.hash);
    expect(row()).toEqual(policyRow);
    await expect(
      replacePolicy(first, { baseHash: "stale-policy-hash", preserveSocket: true }),
    ).resolves.toBeNull();
    expect((await ensureExecApprovalsSnapshot()).file.socket?.token).toBe(token);
  });

  it("reports a saved policy when local socket attachment fails after commit", async () => {
    const before = await ensureExecApprovalsSnapshot();
    const security = before.file.defaults?.security === "deny" ? "allowlist" : "deny";
    vi.spyOn(execApprovalsSocket, "attachExecApprovalsSocket").mockRejectedValueOnce(
      new Error("client credentials are busy"),
    );
    await expect(
      replacePolicy(
        { ...before.file, defaults: { security } },
        { baseHash: before.hash, preserveSocket: true },
      ),
    ).rejects.toThrow(
      "Exec approval policy was saved, but local socket credentials could not be updated",
    );
    const after = readExecApprovalsSnapshot();
    expect(after.file.defaults?.security).toBe(security);
    expect(after.hash).not.toBe(before.hash);
  });

  it("throws typed snapshot failures while enforcement reads fail closed", () => {
    makeStateDatabaseUnavailable();

    expect(() => readExecApprovalsSnapshot()).toThrow("Exec approvals SQLite state is unavailable");
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toContain("unavailable");
  });

  it("aborts agent deletion before commit when policy storage disappears", async () => {
    const commit = vi.fn(async () => "committed");
    await withDeletion("removed", async (deletion) => {
      openOpenClawStateDatabase().db.exec("DROP TABLE exec_approvals_config");
      await expect(withAgentExecApprovalsRemoved("removed", commit, deletion)).rejects.toThrow();
      expect(commit).not.toHaveBeenCalled();
    });
  });

  it("fences a concurrent writer across a slow deletion commit", async () => {
    saveExecApprovals(
      policy(undefined, { removed: { security: "allowlist" }, kept: { security: "deny" } }),
    );
    const { deletion, finish } = await pauseDeletion("removed");
    try {
      const file = loadExecApprovals();
      expect(file.agents).toEqual({ kept: { security: "deny" } });
      await expect(
        replacePolicy({ ...file, agents: { ...file.agents, removed: { security: "full" } } }),
      ).rejects.toMatchObject({ name: "ExecApprovalsMutationFencedError" });
    } finally {
      finish();
    }

    await expect(deletion).resolves.toBe("committed");
  });

  it("allows unrelated writers while deleting an agent with no approval policy", async () => {
    saveExecApprovals({ version: 1, agents: { kept: { security: "deny" } } });
    const { deletion, finish } = await pauseDeletion("missing");
    try {
      saveExecApprovals(policy(undefined, { kept: { security: "full" } }));
      expect(loadExecApprovals().agents?.kept?.security).toBe("full");
    } finally {
      finish();
    }
    await deletion;
  });

  it("removes and restores every policy alias when the surrounding commit fails", async () => {
    const agents = {
      "Agent A": { security: "allowlist" },
      "agent-a": { security: "full" },
      kept: { security: "deny" },
    } satisfies ExecApprovalsFile["agents"];
    saveExecApprovals(policy(undefined, agents));
    let policiesDuringCommit: ReturnType<typeof loadExecApprovals>["agents"] = undefined;

    await expect(
      removeAgentPolicies("Agent A", async () => {
        policiesDuringCommit = loadExecApprovals().agents;
        throw new Error("roster commit failed");
      }),
    ).rejects.toThrow("roster commit failed");

    expect(policiesDuringCommit).toEqual({ kept: { security: "deny" } });
    expect(loadExecApprovals().agents).toEqual(agents);
  });

  it.each(["missing", "superseded"] as const)(
    "requires current deletion authority before removing policy or committing the roster (%s)",
    async (journal) => {
      const original = journal === "superseded" ? { security: "full" as const } : undefined;
      saveExecApprovals({ version: 1, agents: original ? { removed: original } : {} });
      const commit = vi.fn(async () => "committed");
      await withDeletion("removed", async (deletion) => {
        await withForeignDatabase((foreign) => {
          foreign
            .prepare(
              journal === "missing"
                ? "DELETE FROM agent_deletion_journal WHERE agent_id = 'removed'"
                : "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'removed'",
            )
            .run();
          if (journal === "missing") {
            publishAgentDeletionJournalStatus(openOpenClawStateDatabase().db, "removed", "absent");
          }
        });
        await expect(withAgentExecApprovalsRemoved("removed", commit, deletion)).rejects.toThrow(
          "deletion no longer owns",
        );
        expect(commit).not.toHaveBeenCalled();
        expect(loadExecApprovals().agents?.removed?.security).toBe(original?.security);
      });
    },
  );

  it("uses the foreign-committed policy and removes aliases without host SQL", async () => {
    saveExecApprovals({ version: 1, agents: { removed: { security: "full" } } });
    await withDeletion("removed", async (deletion) => {
      await withForeignDatabase((foreign) => {
        writeExecApprovalsConfigRow({
          db: foreign,
          file: policy(undefined, {
            removed: { security: "allowlist" },
            kept: { security: "deny" },
          }),
        });
      });
      await withoutHostSql(async () => {
        await withAgentExecApprovalsRemoved("removed", async () => "committed", deletion);
      });
      expect(loadExecApprovals().agents).toEqual({ kept: { security: "deny" } });
    });
  });

  it("retires prepared cron uses before COMMIT and keeps the row when the host refuses that grant", async () => {
    saveExecApprovals(policy({ security: "deny" }, { removed: { security: "full" } }));
    await withDeletion("removed", async (deletion) => {
      const use = await prepareCronExecHostPolicyUse(captureOpenClawStateWorkerContext(), {
        agentId: "removed",
        security: "full",
        ask: "off",
      });
      const commit = vi.fn(async () => "committed");
      let reachedCommit = false;
      try {
        await expect(
          withAgentExecApprovalsRemoved("removed", commit, {
            ...deletion,
            runWithWorker(operation, options) {
              return deletion.runWithWorker(operation, {
                ...options,
                onAdmission(request, key) {
                  options?.onAdmission?.(request, key);
                  if (request.stage === "commit") {
                    reachedCommit = true;
                    expect(use.assertCurrent).toThrow("policy changed");
                    throw new Error("synthetic lost host grant");
                  }
                },
              });
            },
          }),
        ).rejects.toThrow("synthetic lost host grant");
        expect(reachedCommit).toBe(true);
        expect(commit).not.toHaveBeenCalled();
        expect(loadExecApprovals().agents?.removed?.security).toBe("full");
        expect(use.assertCurrent).toThrow("policy changed");
      } finally {
        use.release();
      }
    });
  });

  it("restores snapshots and honors rollback CAS", async () => {
    const missing = readExecApprovalsSnapshot();
    const first = await replacePolicy(policy({ security: "deny" }));
    assert(first, "missing first snapshot");
    expect(await restoreExecApprovalsSnapshotLocked(missing, first.hash)).toBe(true);
    expect(readExecApprovalsSnapshot().exists).toBe(false);

    saveExecApprovals(policy({ security: "allowlist" }));
    const original = readExecApprovalsSnapshot();
    const newer = await replacePolicy({ ...original.file, defaults: { security: "full" } });
    assert(newer, "missing newer snapshot");
    expect(await restoreExecApprovalsSnapshotLocked(original, original.hash)).toBe(false);
    expect(await restoreExecApprovalsSnapshotLocked(original, newer.hash)).toBe(true);
    expect(loadExecApprovals().defaults?.security).toBe("allowlist");
  });

  it("observes foreign commits before worker mutation and rejects stale cross-handle CAS", async () => {
    saveExecApprovals(policy({ security: "deny" }));
    const stale = readExecApprovalsSnapshot();
    await withForeignDatabase((db) => {
      runSqliteImmediateTransactionSync(db, () => {
        writeExecApprovalsConfigRow({
          db,
          file: policy({ security: "full" }, { external: { security: "deny" } }),
        });
      });
    });
    const current = readExecApprovalsSnapshot();
    expect(current.hash).not.toBe(stale.hash);
    expect(current.file.defaults?.security).toBe("full");
    await withoutHostSql(async () => {
      await expect(replacePolicy(stale.file, { baseHash: stale.hash })).resolves.toBeNull();
      const updated = await updateExecApprovals({
        update: { kind: "ensure-agent", agentId: "added", policy: { security: "allowlist" } },
      });
      expect(updated?.file).toMatchObject({
        defaults: { security: "full" },
        agents: { external: { security: "deny" }, added: { security: "allowlist" } },
      });
    });
  });

  it("settles competing policy saves in writer submission order", async () => {
    const before = await ensureExecApprovalsSnapshot();
    await withoutHostSql(async () => {
      const [first, second] = await Promise.all(
        (["allowlist", "deny"] as const).map((security) =>
          replacePolicy({ ...before.file, defaults: { security } }, { baseHash: before.hash }),
        ),
      );
      expect(first?.file.defaults?.security).toBe("allowlist");
      expect(second).toBeNull();
    });
    expect(loadExecApprovals().defaults?.security).toBe("allowlist");
  });

  it.each(["usage", "one-shot", "allow-always"] as const)(
    "fences concurrent %s writes only when they can change policy",
    async (kind) => {
      const input = authorizeEcho();
      const assertCurrent = await commitExecAuthorizationLocked(input);
      const failures: unknown[] = [];
      const stages: string[] = [];
      workerProbe.admission(workerAdmission, (request, grant, admit) => {
        admit(request, grant);
        stages.push(request.stage);
        try {
          assertCurrent();
        } catch (error) {
          failures.push(error);
        }
      });
      const requests = [commitExecAuthorizationLocked({ ...input, command: "echo after" })];
      if (kind !== "usage") {
        requests.push(
          commitExecAuthorizationLocked({
            ...input,
            authorization: {
              ...input.authorization,
              source: "explicit-approval",
              policySnapshot: createExecApprovalPolicySnapshot({
                file: loadExecApprovals(),
                agentId: "main",
              }),
            },
            allowAlwaysDecision:
              kind === "one-shot"
                ? { kind: "one-shot", reasons: ["prompt-only"] }
                : { kind: "exact-command", commandText: "echo approved" },
            command: "echo after",
          }),
        );
      }
      const next = await Promise.all(requests);
      expect(stages).toEqual(["transaction", "commit"]);
      const changing = expect.objectContaining({
        message: "Exec approval policy is unavailable or changing before execution",
      });
      expect(failures).toEqual(kind === "allow-always" ? [changing, changing] : []);
      expect(assertCurrent).not.toThrow();
      for (const guard of next) {
        expect(guard).not.toThrow();
      }
      expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedCommand).toBe("echo after");
    },
  );

  it("does not batch authorizations across an intervening policy denial", async () => {
    const input = authorizeEcho();
    const sql = observeMainThreadSql();
    const publications: ExecApprovalsPublicationValue[] = [];
    const releaseFacts = execApprovalsPublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        const fact = change.receipt.facts.get("current");
        if (fact?.kind === "postimage") {
          publications.push(fact.value);
        }
      }
    });
    try {
      const [before, denied, after] = await Promise.allSettled([
        commitExecAuthorizationLocked(input),
        updateExecApprovals({
          update: { kind: "ensure-agent", agentId: "*", policy: { security: "deny" } },
        }),
        commitExecAuthorizationLocked({ ...input, command: "echo after" }),
      ]);
      expect(before.status).toBe("fulfilled");
      expect(denied.status).toBe("fulfilled");
      if (denied.status === "fulfilled") {
        expect(denied.value?.file.agents).toMatchObject({
          "*": { security: "deny" },
          main: { allowlist: [{ lastUsedCommand: "echo before" }] },
        });
      }
      expect(after).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: "Exec approval changed before execution" }),
      });
      expect(publications.map((publication) => publication.change)).toEqual(["usage", "policy"]);
      expect(publications[0]?.file.agents?.main?.allowlist?.[0]?.lastUsedCommand).toBe(
        "echo before",
      );
      expect(publications[1]?.file.agents?.["*"]?.security).toBe("deny");
      sql.expectIdle();
    } finally {
      releaseFacts();
      sql.restore();
    }
    expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedCommand).toBe("echo before");
  });

  it("settles authorizations with independent request lifetimes separately", async () => {
    const input = authorizeEcho("echo canceled");
    let canceled = false;
    workerProbe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit") {
        canceled = true;
      }
      admit(request, grant);
    });
    const [revoked, current] = await Promise.allSettled([
      commitExecAuthorizations(input, () => {
        if (canceled) {
          throw new Error("request canceled");
        }
      }),
      commitExecAuthorizations({ ...input, command: "echo current" }),
    ]);
    expect(revoked).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "request canceled" }),
    });
    expect(current.status).toBe("fulfilled");
    expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedCommand).toBe("echo current");
  });

  it.each([
    ["source", ""],
    ["Doctor claim", ".doctor-importing"],
  ])(
    "blocks runtime reads while the retired %s exists, then rechecks after removal",
    (_, suffix) => {
      closeOpenClawStateDatabaseForTest();
      const sourcePath = fixturePath("exec-approvals.json");
      const legacyPath = `${sourcePath}${suffix}`;
      fs.writeFileSync(legacyPath, serializeExecApprovals({ version: 1, agents: {} }));
      execApprovalsStoreTesting.reset();
      expect(loadExecApprovals).toThrow(
        expect.objectContaining({
          constructor: ExecApprovalsMigrationRequiredError,
          message: `Legacy exec approvals exist at ${sourcePath}. Run \`openclaw doctor --fix\` with OPENCLAW_STATE_DIR set to ${path.dirname(sourcePath)} before using exec approvals.`,
        }),
      );

      fs.rmSync(legacyPath);
      expect(loadExecApprovals()).toMatchObject({ version: 1, agents: {} });
    },
  );

  it.each([
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])("detects legacy state at every source-claim-source probe", (first, claim, second) => {
    const sourcePath = fixturePath("exec-approvals.json");
    const probe = vi
      .fn<(filePath: string) => boolean>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(claim)
      .mockReturnValueOnce(second);

    expect(() => assertNoPendingLegacyExecApprovals({ pathMayExist: probe })).toThrow(
      ExecApprovalsMigrationRequiredError,
    );
    expect(probe.mock.calls.map(([filePath]) => filePath)).toEqual([
      sourcePath,
      `${sourcePath}.doctor-importing`,
      sourcePath,
    ]);
  });
});
