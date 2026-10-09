import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { sha256Hex } from "./crypto-digest.js";
import { commitExecAuthorizationLocked } from "./exec-approvals-authorization.js";
import type { ExecAuthorizationCommitInput } from "./exec-approvals-contracts.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
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

const TEST_DELETION_OPERATION_ID = "test-deletion-operation";

function seedAgentDeletionJournal(agentId: string, operationId = TEST_DELETION_OPERATION_ID): void {
  openOpenClawStateDatabase()
    .db.prepare(
      `INSERT INTO agent_deletion_journal (
         agent_id, operation_id, agent_dir, workspace_dir, sessions_dir, created_at
       ) VALUES (?, ?, '/agent', '/workspace', '/sessions', 1)`,
    )
    .run(agentId, operationId);
}

beforeEach(() => {
  createStateDir();
  loggerWarn.mockReset();
  execApprovalsStoreTesting.reset();
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
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

  it.each(readOnlyLoaders)(
    "does not migrate older shared state for a $name read-only load",
    async ({ load }) => {
      saveExecApprovals({
        version: 1,
        defaults: { security: "allowlist" },
        agents: {},
      });
      const statePath = resolveOpenClawStateSqlitePath();
      closeOpenClawStateDatabaseForTest();
      const older = new DatabaseSync(statePath);
      older.exec(`
      PRAGMA user_version = 7;
      UPDATE schema_meta SET schema_version = 7 WHERE meta_key = 'primary';
    `);
      older.close();

      expect((await load()).defaults?.security).toBe("allowlist");

      const after = new DatabaseSync(statePath, { readOnly: true });
      expect(after.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
      after.close();
    },
  );

  it.each(readOnlyLoaders)(
    "fails closed for an unavailable $name read-only owner",
    async ({ load }) => {
      makeStateDatabaseUnavailable();
      expect((await load()).defaults).toMatchObject({ security: "deny", ask: "off" });
      expect(loggerWarn).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the captured legacy gate and repair directory when an async read resumes elsewhere", async () => {
    const original = process.env.OPENCLAW_STATE_DIR;
    if (!original) {
      throw new Error("missing test state dir");
    }
    fs.writeFileSync(path.join(original, "exec-approvals.json"), "{}");
    const loaded = loadExecApprovalsReadOnlyAsync();
    const foreign = createStateDir();
    await expect(loaded).rejects.toMatchObject({
      name: "ExecApprovalsMigrationRequiredError",
      message: expect.stringContaining(`OPENCLAW_STATE_DIR set to ${original}`),
    });
    expect(fs.existsSync(path.join(original, "state", "openclaw.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(foreign, "state", "openclaw.sqlite"))).toBe(false);
  });

  it("uses a permissive missing-row default without creating the row", () => {
    expect(loadExecApprovals()).toEqual({
      version: 1,
      socket: { path: undefined, token: undefined },
      defaults: {
        security: undefined,
        ask: undefined,
        askFallback: undefined,
        autoAllowSkills: undefined,
      },
      agents: {},
    });
    expect(readExecApprovalsSnapshot()).toMatchObject({
      exists: false,
      raw: null,
      hash: expect.stringMatching(/^missing:/u),
    });
    expect(row()).toBeUndefined();
  });

  it("persists CRUD state and all denormalized projections", async () => {
    const sql = observeMainThreadSql();
    let written: Awaited<ReturnType<typeof updateExecApprovals>>;
    try {
      written = await updateExecApprovals({
        update: {
          kind: "replace",
          file: {
            version: 1,
            socket: { path: "/tmp/openclaw-approvals.sock", token: "secret" },
            defaults: {
              security: "allowlist",
              ask: "on-miss",
              askFallback: "deny",
              autoAllowSkills: true,
            },
            agents: {
              main: { allowlist: [{ pattern: "/usr/bin/rg" }, { pattern: "/usr/bin/git" }] },
              worker: { allowlist: [{ pattern: "/usr/bin/jq" }] },
            },
          },
        },
      });
      sql.expectIdle();
    } finally {
      sql.restore();
    }

    expect(written?.exists).toBe(true);
    expect(loadExecApprovals().defaults?.security).toBe("allowlist");
    expect(row()).toMatchObject({
      config_key: "current",
      socket_path: "/tmp/openclaw-approvals.sock",
      has_socket_token: 1,
      default_security: "allowlist",
      default_ask: "on-miss",
      default_ask_fallback: "deny",
      auto_allow_skills: 1,
      agent_count: 2,
      allowlist_count: 3,
    });
  });

  it.each(["update", "direct"] as const)(
    "keeps malformed %s writes fail-closed instead of discarding invalid policy fields",
    async (writer) => {
      const file = {
        version: 1,
        defaults: { ask: "always" },
        agents: { runner: { ask: "invalid" } },
      } as unknown as ExecApprovalsFile;
      if (writer === "update") {
        const written = await updateExecApprovals({ update: { kind: "replace", file } });
        expect(written?.file.defaults).toMatchObject({ security: "deny", ask: "off" });
        expect(written?.raw).toBe(serializeExecApprovals(file));
      } else {
        writeExecApprovalsConfigRow({ db: openOpenClawStateDatabase().db, file });
      }
      expect(readExecApprovalsSnapshot().raw).toBe(serializeExecApprovals(file));
      expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
      expect((await loadExecApprovalsReadOnlyAsync()).defaults).toMatchObject({
        security: "deny",
        ask: "off",
      });
    },
  );

  it("preserves raw-byte CAS hashes and returns null on a stale base", async () => {
    const missing = readExecApprovalsSnapshot();
    const first = await updateExecApprovals({
      baseHash: missing.hash,
      update: { kind: "replace", file: { version: 1, defaults: { security: "deny" }, agents: {} } },
    });
    expect(first?.raw).not.toBeNull();
    expect(first?.hash).toBe(sha256Hex(first?.raw ?? ""));
    if (!first) {
      throw new Error("missing first snapshot");
    }

    await expect(
      updateExecApprovals({
        baseHash: missing.hash,
        update: {
          kind: "replace",
          file: { version: 1, defaults: { security: "full" }, agents: {} },
        },
      }),
    ).resolves.toBeNull();

    const updated = await updateExecApprovals({
      baseHash: first?.hash,
      update: { kind: "replace", file: { ...first.file, defaults: { security: "full" } } },
    });
    expect(updated?.file.defaults?.security).toBe("full");
  });

  it("rolls back a policy replacement when current authority ends before commit", async () => {
    const before = await ensureExecApprovalsSnapshot();
    let current = true;
    let commitObserved = false;
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            commitObserved = true;
            current = false;
          }
          admit(request, grant);
        }, attachment),
    );
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
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "transaction") {
            transactions();
          }
          admit(request, grant);
        }, attachment),
    );
    const second = (await ensureExecApprovalsSnapshot()).file;
    expect(transactions).not.toHaveBeenCalled();
    expect(first.socket?.token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first.socket?.token).toBe(second.socket?.token);
    expect(first.socket?.path).toBe(second.socket?.path);
    expect(row()).toMatchObject({ has_socket_token: 1, socket_path: first.socket?.path });
  });

  it.each([
    { name: "invalid JSON", raw: "{not-json" },
    {
      name: "an invalid own prototype-key policy",
      raw: '{"version":1,"agents":{"__proto__":{"security":42}}}',
    },
  ])("fails closed and warns once for $name", ({ raw }) => {
    const { db } = openOpenClawStateDatabase();
    db.prepare(
      "INSERT INTO exec_approvals_config (config_key, raw_json, socket_path, has_socket_token, default_security, default_ask, default_ask_fallback, auto_allow_skills, agent_count, allowlist_count, updated_at_ms) VALUES (?, ?, NULL, 0, NULL, NULL, NULL, NULL, 0, 0, 1)",
    ).run("current", raw);

    expect(loadExecApprovals().defaults).toMatchObject({ security: "deny", ask: "off" });
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toContain("malformed");
  });

  it("throws typed snapshot failures while enforcement reads fail closed", () => {
    makeStateDatabaseUnavailable();

    expect(() => readExecApprovalsSnapshot()).toThrow("Exec approvals SQLite state is unavailable");
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(loadExecApprovals().defaults?.security).toBe("deny");
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toContain("unavailable");
  });

  it("aborts agent deletion before commit when the approvals store is unavailable", async () => {
    makeStateDatabaseUnavailable();
    const commit = vi.fn(async () => "committed");

    await expect(
      withAgentExecApprovalsRemoved(
        { agentId: "removed", operationId: TEST_DELETION_OPERATION_ID },
        commit,
      ),
    ).rejects.toThrow("Exec approvals SQLite state is unavailable");
    expect(commit).not.toHaveBeenCalled();
  });

  it("removes one agent and preserves wildcard and unrelated policy", async () => {
    saveExecApprovals({
      version: 1,
      agents: {
        "*": { security: "deny" },
        main: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/old" }] },
        kept: { security: "allowlist", allowlist: [{ pattern: "/usr/bin/keep" }] },
      },
    });
    seedAgentDeletionJournal("main");

    const sql = observeMainThreadSql();
    try {
      await expect(
        withAgentExecApprovalsRemoved(
          { agentId: "main", operationId: TEST_DELETION_OPERATION_ID },
          async () => "ok",
        ),
      ).resolves.toBe("ok");
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    expect(loadExecApprovals().agents).toEqual({
      "*": { security: "deny" },
      kept: expect.objectContaining({
        allowlist: [expect.objectContaining({ pattern: "/usr/bin/keep" })],
      }),
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
    seedAgentDeletionJournal("removed");
    const { promise: commitStarted, resolve: notifyCommitStarted } = createDeferred();
    const { promise: commitGate, resolve: finishCommit } = createDeferred();
    const deletion = withAgentExecApprovalsRemoved(
      { agentId: "removed", operationId: TEST_DELETION_OPERATION_ID },
      async () => {
        notifyCommitStarted();
        await commitGate;
        return "committed";
      },
    );

    await commitStarted;
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
    seedAgentDeletionJournal("missing");
    const { promise: commitStarted, resolve: notifyCommitStarted } = createDeferred();
    const { promise: commitGate, resolve: finishCommit } = createDeferred();
    const deletion = withAgentExecApprovalsRemoved(
      { agentId: "missing", operationId: TEST_DELETION_OPERATION_ID },
      async () => {
        notifyCommitStarted();
        await commitGate;
      },
    );

    await commitStarted;
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
    seedAgentDeletionJournal("agent-a");
    let policiesDuringCommit: ReturnType<typeof loadExecApprovals>["agents"] = undefined;

    await expect(
      withAgentExecApprovalsRemoved(
        { agentId: "Agent A", operationId: TEST_DELETION_OPERATION_ID },
        async () => {
          policiesDuringCommit = loadExecApprovals().agents;
          throw new Error("roster commit failed");
        },
      ),
    ).rejects.toThrow("roster commit failed");

    expect(policiesDuringCommit).toEqual({ kept: { security: "deny" } });
    expect(loadExecApprovals().agents).toEqual({
      "Agent A": { security: "allowlist" },
      "agent-a": { security: "full" },
      kept: { security: "deny" },
    });
  });

  it.each(["missing", "superseded"] as const)(
    "requires current deletion authority before commit (%s)",
    async (journal) => {
      if (journal === "superseded") {
        seedAgentDeletionJournal("missing", "replacement-deletion-operation");
      }
      const commit = vi.fn(async () => "committed");

      await expect(
        withAgentExecApprovalsRemoved(
          { agentId: "missing", operationId: TEST_DELETION_OPERATION_ID },
          commit,
        ),
      ).rejects.toMatchObject({
        name: "ExecApprovalsMutationFencedError",
      });
      expect(commit).not.toHaveBeenCalled();
    },
  );

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
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        createAdmission((request, grant) => {
          if (request.stage === "commit") {
            canceled = true;
          }
          admit(request, grant);
        }, attachment),
    );
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

  it("caches an absent legacy result only after all three probes are clear", () => {
    const clearProbe = vi.fn<(filePath: string) => boolean>(() => false);
    assertNoPendingLegacyExecApprovals({ pathMayExist: clearProbe });
    expect(clearProbe).toHaveBeenCalledTimes(3);

    const laterProbe = vi.fn<(filePath: string) => boolean>(() => true);
    assertNoPendingLegacyExecApprovals({ pathMayExist: laterProbe });
    expect(laterProbe).not.toHaveBeenCalled();
  });
});
