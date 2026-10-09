import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  withAgentDeletion,
  type AgentDeletionOperation,
} from "../agents/agent-lifecycle-registry.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { commitExecAuthorizationLocked } from "./exec-approvals-authorization.js";
import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { prepareCronExecHostPolicyUse } from "./exec-approvals-cron-policy.js";
import {
  assertNoPendingLegacyExecApprovals,
  ExecApprovalsMigrationRequiredError,
} from "./exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  snapshotFromExecApprovalsRow,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import {
  commitExecAuthorizations,
  ensureExecApprovalsSnapshot,
  loadExecApprovals,
  loadExecApprovalsReadOnly,
  loadExecApprovalsReadOnlyAsync,
  prepareExecApprovalsCurrentRead,
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

type ExecApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "exec_approvals_config">;

const tempDirs: string[] = [];
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

function createStateDir(): string {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exec-approvals-db-")));
  tempDirs.push(stateDir);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  return stateDir;
}

function row() {
  return executeSqliteQueryTakeFirstSync(
    openOpenClawStateDatabase().db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(openOpenClawStateDatabase().db)
      .selectFrom("exec_approvals_config")
      .selectAll()
      .where("config_key", "=", "current"),
  );
}

function makeStateDatabaseUnavailable(): void {
  closeOpenClawStateDatabaseForTest();
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("missing test state dir");
  }
  fs.writeFileSync(path.join(stateDir, "state"), "not a directory");
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

beforeEach(() => {
  createStateDir();
  loggerWarn.mockReset();
  execApprovalsStoreTesting.reset();
});

afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
  execApprovalsStoreTesting.reset();
  envSnapshot.restore();
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
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

      expect(await load()).toMatchObject({
        version: 1,
        agents: {},
      });
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
    const written = await updateExecApprovals({ update: { kind: "replace", file } });
    expect(written?.file.defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(written?.raw).toBe(serializeExecApprovals(file));
    expect(readExecApprovalsSnapshot().raw).toBe(serializeExecApprovals(file));
    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
    expect((await loadExecApprovalsReadOnlyAsync()).defaults).toMatchObject({
      security: "deny",
      ask: "off",
    });
  });

  it("rolls back a policy replacement when current authority ends before commit", async () => {
    const before = await ensureExecApprovalsSnapshot();
    let current = true;
    let commitObserved = false;
    workerProbe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit") {
        commitObserved = true;
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
    expect(commitObserved).toBe(true);
    expect(readExecApprovalsSnapshot().hash).toBe(before.hash);
  });

  it("mints one socket token and reuses it on later initialization", async () => {
    const first = (await ensureExecApprovalsSnapshot()).file;
    const transactions = vi.fn();
    workerProbe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "transaction") {
        transactions();
      }
      admit(request, grant);
    });
    const second = (await ensureExecApprovalsSnapshot()).file;
    expect(transactions).not.toHaveBeenCalled();
    expect(first.socket?.token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.socket?.token).toBe(second.socket?.token);
    expect(first.socket?.path).toBe(second.socket?.path);
    expect(row()).toMatchObject({ has_socket_token: 1, socket_path: first.socket?.path });
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
    saveExecApprovals({
      version: 1,
      agents: {
        removed: { security: "allowlist" },
        kept: { security: "deny" },
      },
    });
    const { promise: commitStarted, resolve: notifyCommitStarted } = createDeferred();
    const { promise: commitGate, resolve: finishCommit } = createDeferred();
    const deletion = removeAgentPolicies("removed", async () => {
      notifyCommitStarted();
      await commitGate;
      return "committed";
    });

    await awaitGateBeforeSettlement(
      commitStarted,
      deletion,
      "Deletion settled before roster commit",
    );
    try {
      const file = loadExecApprovals();
      expect(file.agents).toEqual({ kept: { security: "deny" } });
      await expect(
        updateExecApprovals({
          update: {
            kind: "replace",
            file: {
              ...file,
              agents: { ...file.agents, removed: { security: "full" } },
            },
          },
        }),
      ).rejects.toMatchObject({ name: "ExecApprovalsMutationFencedError" });
    } finally {
      finishCommit();
    }

    await expect(deletion).resolves.toBe("committed");
  });

  it("allows unrelated writers while deleting an agent with no approval policy", async () => {
    saveExecApprovals({ version: 1, agents: { kept: { security: "deny" } } });
    const { promise: commitStarted, resolve: notifyCommitStarted } = createDeferred();
    const { promise: commitGate, resolve: finishCommit } = createDeferred();
    const deletion = removeAgentPolicies("missing", async () => {
      notifyCommitStarted();
      await commitGate;
    });

    await awaitGateBeforeSettlement(
      commitStarted,
      deletion,
      "Deletion settled before roster commit",
    );
    try {
      saveExecApprovals({
        version: 1,
        agents: { kept: { security: "full" } },
      });
      expect(loadExecApprovals().agents?.kept?.security).toBe("full");
    } finally {
      finishCommit();
    }
    await deletion;
  });

  it("removes and restores every policy alias when the surrounding commit fails", async () => {
    saveExecApprovals({
      version: 1,
      agents: {
        "Agent A": { security: "allowlist" },
        "agent-a": { security: "full" },
        kept: { security: "deny" },
      },
    });
    let policiesDuringCommit: ReturnType<typeof loadExecApprovals>["agents"] = undefined;

    await expect(
      removeAgentPolicies("Agent A", async () => {
        policiesDuringCommit = loadExecApprovals().agents;
        throw new Error("roster commit failed");
      }),
    ).rejects.toThrow("roster commit failed");

    expect(policiesDuringCommit).toEqual({ kept: { security: "deny" } });
    expect(loadExecApprovals().agents).toEqual({
      "Agent A": { security: "allowlist" },
      "agent-a": { security: "full" },
      kept: { security: "deny" },
    });
  });

  it.each(["missing", "superseded"] as const)(
    "requires current deletion authority before removing policy or committing the roster (%s)",
    async (journal) => {
      const policy = journal === "superseded" ? { security: "full" as const } : undefined;
      saveExecApprovals({ version: 1, agents: policy ? { removed: policy } : {} });
      const commit = vi.fn(async () => "committed");
      await withDeletion("removed", async (deletion) => {
        const foreign = new DatabaseSync(resolveOpenClawStateSqlitePath());
        try {
          foreign
            .prepare(
              journal === "missing"
                ? "DELETE FROM agent_deletion_journal WHERE agent_id = 'removed'"
                : "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'removed'",
            )
            .run();
        } finally {
          foreign.close();
        }
        await expect(withAgentExecApprovalsRemoved("removed", commit, deletion)).rejects.toThrow(
          "deletion no longer owns",
        );
        expect(commit).not.toHaveBeenCalled();
        expect(loadExecApprovals().agents?.removed?.security).toBe(policy?.security);
      });
    },
  );

  it("uses the foreign-committed policy and removes aliases without host SQL", async () => {
    saveExecApprovals({ version: 1, agents: { removed: { security: "full" } } });
    await withDeletion("removed", async (deletion) => {
      const foreign = new DatabaseSync(resolveOpenClawStateSqlitePath());
      try {
        writeExecApprovalsConfigRow({
          db: foreign,
          file: {
            version: 1,
            agents: {
              removed: { security: "allowlist" },
              kept: { security: "deny" },
            },
          },
        });
      } finally {
        foreign.close();
      }
      const sql = observeHostDataSql();
      try {
        await withAgentExecApprovalsRemoved("removed", async () => "committed", deletion);
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(loadExecApprovals().agents).toEqual({ kept: { security: "deny" } });
    });
  });

  it("retires prepared cron uses before COMMIT and keeps the row when the host refuses that grant", async () => {
    saveExecApprovals({
      version: 1,
      defaults: { security: "deny" },
      agents: { removed: { security: "full" } },
    });
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
    const first = await updateExecApprovals({
      update: { kind: "replace", file: { version: 1, defaults: { security: "deny" }, agents: {} } },
    });
    if (!first) {
      throw new Error("missing first snapshot");
    }
    expect(await restoreExecApprovalsSnapshotLocked(missing, first.hash)).toBe(true);
    expect(readExecApprovalsSnapshot().exists).toBe(false);

    saveExecApprovals({ version: 1, defaults: { security: "allowlist" }, agents: {} });
    const original = readExecApprovalsSnapshot();
    const newer = await updateExecApprovals({
      update: { kind: "replace", file: { ...original.file, defaults: { security: "full" } } },
    });
    if (!newer) {
      throw new Error("missing newer snapshot");
    }
    expect(await restoreExecApprovalsSnapshotLocked(original, original.hash)).toBe(false);
    expect(await restoreExecApprovalsSnapshotLocked(original, newer.hash)).toBe(true);
    expect(loadExecApprovals().defaults?.security).toBe("allowlist");
  });

  it("observes foreign commits before worker mutation and rejects stale cross-handle CAS", async () => {
    saveExecApprovals({ version: 1, defaults: { security: "deny" }, agents: {} });
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    closeOpenClawStateDatabaseForTest();
    const first = new DatabaseSync(databasePath);
    const second = new DatabaseSync(databasePath);
    try {
      first.exec("PRAGMA busy_timeout = 5000");
      second.exec("PRAGMA busy_timeout = 5000");
      const stale = snapshotFromExecApprovalsRow({
        path: "state/openclaw.sqlite#exec_approvals_config",
        row: readExecApprovalsConfigRow(first),
      });
      runSqliteImmediateTransactionSync(second, () => {
        writeExecApprovalsConfigRow({
          db: second,
          file: {
            version: 1,
            defaults: { security: "full" },
            agents: { external: { security: "deny" } },
          },
        });
      });
      const current = snapshotFromExecApprovalsRow({
        path: stale.path,
        row: readExecApprovalsConfigRow(first),
      });
      expect(current.hash).not.toBe(stale.hash);
      expect(current.file.defaults?.security).toBe("full");
      const sql = observeMainThreadSql();
      try {
        await expect(
          updateExecApprovals({
            baseHash: stale.hash,
            update: { kind: "replace", file: stale.file },
          }),
        ).resolves.toBeNull();
        const updated = await updateExecApprovals({
          update: { kind: "ensure-agent", agentId: "added", policy: { security: "allowlist" } },
        });
        expect(updated?.file).toMatchObject({
          defaults: { security: "full" },
          agents: { external: { security: "deny" }, added: { security: "allowlist" } },
        });
        sql.expectIdle();
      } finally {
        sql.restore();
      }
    } finally {
      first.close();
      second.close();
    }
  });

  it("settles competing policy saves in writer submission order", async () => {
    const before = await ensureExecApprovalsSnapshot();
    const sql = observeMainThreadSql();
    try {
      const [first, second] = await Promise.all([
        updateExecApprovals({
          baseHash: before.hash,
          update: {
            kind: "replace",
            file: { ...before.file, defaults: { security: "allowlist" } },
          },
        }),
        updateExecApprovals({
          baseHash: before.hash,
          update: { kind: "replace", file: { ...before.file, defaults: { security: "deny" } } },
        }),
      ]);
      expect(first?.file.defaults?.security).toBe("allowlist");
      expect(second).toBeNull();
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(loadExecApprovals().defaults?.security).toBe("allowlist");
  });

  it("does not batch authorizations across an intervening policy denial", async () => {
    const entry = { id: "echo", pattern: "/usr/bin/echo" };
    saveExecApprovals({ version: 1, agents: { main: { allowlist: [entry] } } });
    const input: ExecAuthorizationCommitInput = {
      agentId: "main",
      matches: [entry],
      command: "echo before",
      authorization: {
        source: "current-policy",
        security: "allowlist",
        ask: "on-miss",
        allowlistSatisfied: true,
      },
    };
    // Admit the final reader before checking the warmed write path for caller SQL.
    prepareExecApprovalsCurrentRead(captureOpenClawStateWorkerContext());
    const sql = observeMainThreadSql();
    try {
      const [before, denied, after] = await Promise.allSettled([
        commitExecAuthorizationLocked(input),
        updateExecApprovals({
          update: { kind: "ensure-agent", agentId: "*", policy: { security: "deny" } },
        }),
        commitExecAuthorizationLocked({ ...input, command: "echo after" }),
      ]);
      expect(before.status).toBe("fulfilled");
      expect(denied).toMatchObject({
        status: "fulfilled",
        value: {
          file: {
            agents: {
              "*": { security: "deny" },
              main: { allowlist: [{ lastUsedCommand: "echo before" }] },
            },
          },
        },
      });
      expect(after).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: "Exec approval changed before execution" }),
      });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(loadExecApprovals().agents?.main?.allowlist?.[0]?.lastUsedCommand).toBe("echo before");
  });

  it("settles authorizations with independent request lifetimes separately", async () => {
    const entry = { id: "echo", pattern: "/usr/bin/echo" };
    saveExecApprovals({ version: 1, agents: { main: { allowlist: [entry] } } });
    const input: ExecAuthorizationCommitInput = {
      agentId: "main",
      matches: [entry],
      command: "echo canceled",
      authorization: {
        source: "current-policy",
        security: "allowlist",
        ask: "on-miss",
        allowlistSatisfied: true,
      },
    };
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
      const stateDir = process.env.OPENCLAW_STATE_DIR;
      if (!stateDir) {
        throw new Error("missing test state dir");
      }
      const sourcePath = path.join(stateDir, "exec-approvals.json");
      const legacyPath = `${sourcePath}${suffix}`;
      fs.writeFileSync(legacyPath, serializeExecApprovals({ version: 1, agents: {} }));
      execApprovalsStoreTesting.reset();
      let caught: unknown;
      try {
        loadExecApprovals();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExecApprovalsMigrationRequiredError);
      expect(caught).toMatchObject({
        message: `Legacy exec approvals exist at ${sourcePath}. Run \`openclaw doctor --fix\` with OPENCLAW_STATE_DIR set to ${stateDir} before using exec approvals.`,
      });

      fs.rmSync(legacyPath);
      expect(loadExecApprovals()).toMatchObject({ version: 1, agents: {} });
    },
  );

  it.each([
    [true, false, false],
    [false, true, false],
    [false, false, true],
  ])("detects legacy state at every source-claim-source probe", (first, claim, second) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("missing test state dir");
    }
    const sourcePath = path.join(stateDir, "exec-approvals.json");
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
