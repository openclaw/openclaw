import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  withDisposableOpenClawStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createExecApprovalPolicySnapshot } from "./exec-approvals-allow-always.js";
import { commitExecAuthorizationLocked } from "./exec-approvals-authorization.js";
import { loadMcpToolGrants } from "./exec-approvals-mcp.js";
import { ExecApprovalsMigrationRequiredError } from "./exec-approvals-migration-gate.js";
import { writeExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import {
  loadExecApprovalsReadOnlyAsync,
  readExecApprovalsPolicyReadOnlyAsync,
  prepareCronExecHostPolicyUse,
  prepareExecApprovalsCurrentRead,
  readExecApprovalsSnapshot,
  restoreExecApprovalsSnapshotLocked,
  updateExecApprovalsForMaintenance,
  updateExecApprovals,
} from "./exec-approvals-store.js";
import { testing } from "./exec-approvals-store.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: (name: string) => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: name === "infra/exec-approvals" ? loggerWarn : vi.fn(),
    error: vi.fn(),
  }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    testing.reset();
    cleanup();
  }),
);

beforeEach(() => {
  testing.reset();
  loggerWarn.mockReset();
});

function fixture() {
  const root = tempDirs.make("openclaw-exec-policy-reader-");
  return {
    root,
    env: { OPENCLAW_STATE_DIR: root },
    databasePath: path.join(root, "state", "openclaw.sqlite"),
  };
}

const grant = {
  server: "fixture-server",
  tool: "fixture-tool",
  source: "allow-always" as const,
  addedAt: 1,
};

function seed(env: NodeJS.ProcessEnv, tool = grant.tool, raw?: string) {
  const source = openOpenClawStateDatabase({ env });
  writeExecApprovalsConfigRow({
    db: source.db,
    file: { version: 1, agents: { main: { mcpTools: [{ ...grant, tool }] } } },
    raw,
  });
  return source;
}

function watchNativeSql() {
  requireNodeSqlite();
  return observeMainThreadSql();
}

it("commits unchanged authorization without main-thread SQLite and keeps its captured policy owner", async () => {
  const { root, env } = fixture();
  seed(env);
  prepareExecApprovalsCurrentRead(captureOpenClawStateWorkerContext({ env }));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const calls = watchNativeSql();
  const authorized = commitExecAuthorizationLocked({
    agentId: "main",
    matches: [],
    command: "echo synthetic",
    authorization: {
      source: "current-policy",
      security: "allowlist",
      ask: "on-miss",
      allowlistSatisfied: true,
    },
  });
  const foreign = fixture();
  vi.stubEnv("OPENCLAW_STATE_DIR", foreign.root);
  const assertCurrent = await authorized;
  expect(calls.count()).toBe(0);
  vi.restoreAllMocks();
  const sql = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
  const peer = new (requireNodeSqlite().DatabaseSync)(path.join(root, "state", "openclaw.sqlite"));
  try {
    expect(assertCurrent).not.toThrow();
    expect(sql.queries).toEqual([
      'select "raw_json" from "exec_approvals_config" where "config_key" = ?',
    ]);
    writeExecApprovalsConfigRow({
      db: peer,
      file: { version: 1, defaults: { security: "deny" } },
    });
    sql.queries.length = 0;
    expect(assertCurrent).toThrow("Exec approval changed before execution");
    expect(sql.queries).toEqual([
      'select "raw_json" from "exec_approvals_config" where "config_key" = ?',
    ]);
  } finally {
    sql.restore();
    peer.close();
  }
  expect(fs.existsSync(foreign.databasePath)).toBe(false);
});

it("settles batched usage commits in order while isolating refused authorizations", async () => {
  const { root, env } = fixture();
  const source = seed(env);
  const entry = { id: "fixture-echo", pattern: "/usr/bin/echo" };
  writeExecApprovalsConfigRow({
    db: source.db,
    file: { version: 1, agents: { main: { allowlist: [entry] } } },
  });
  prepareExecApprovalsCurrentRead(captureOpenClawStateWorkerContext({ env }));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const input = {
    agentId: "main",
    matches: [entry],
    command: "echo first",
    authorization: {
      source: "current-policy" as const,
      security: "allowlist" as const,
      ask: "on-miss" as const,
      allowlistSatisfied: true,
    },
  };
  const calls = watchNativeSql();
  const outcomes = await Promise.allSettled([
    commitExecAuthorizationLocked(input),
    commitExecAuthorizationLocked({ ...input, matches: [{ pattern: "/missing" }] }),
    commitExecAuthorizationLocked({ ...input, command: "echo last" }),
  ]);
  expect(outcomes.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(calls.count()).toBe(0);
  vi.restoreAllMocks();
  const stored = await loadExecApprovalsReadOnlyAsync({ env });
  expect(stored.agents?.main?.allowlist).toEqual([
    expect.objectContaining({
      ...entry,
      lastUsedCommand: "echo last",
      lastUsedAt: expect.any(Number),
    }),
  ]);
  for (const result of outcomes) {
    if (result.status === "fulfilled") {
      expect(result.value).not.toThrow();
    }
  }
});

it("keeps independent authorization scopes isolated after settlement", async () => {
  const { root, env } = fixture();
  seed(env);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const first = new AsyncWorkScope();
  const second = new AsyncWorkScope();
  const prepare = () =>
    commitExecAuthorizationLocked({
      agentId: "main",
      matches: [],
      command: "echo synthetic",
      authorization: {
        source: "current-policy",
        security: "allowlist",
        ask: "on-miss",
        allowlistSatisfied: true,
      },
    });
  try {
    const [firstGuard, secondGuard] = await Promise.all([first.run(prepare), second.run(prepare)]);
    first.beginClose(new Error("first authorization retired"));
    expect(firstGuard).toThrow("first authorization retired");
    expect(secondGuard).not.toThrow();
  } finally {
    await Promise.all([first.drain(), second.drain()]);
  }
});

it("drains an accepted authorization when maintenance closes before batch dispatch", async () => {
  const { root, env } = fixture();
  seed(env);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const maintenance = createOpenClawDatabaseMaintenanceScope();
  let pending: Promise<() => void> | undefined;
  maintenance.run(() => {
    pending = commitExecAuthorizationLocked({
      agentId: "main",
      matches: [],
      command: "echo synthetic",
      authorization: {
        source: "current-policy",
        security: "allowlist",
        ask: "on-miss",
        allowlistSatisfied: true,
      },
    });
  });
  await Promise.all([expect(pending).resolves.toBeTypeOf("function"), maintenance.close()]);
});

it.each(["cached", "fresh"] as const)(
  "loads exact-agent policy grants from a %s source without caller SQLite",
  async (mode) => {
    expect(isMainThread).toBe(true);
    const { env } = fixture();
    const source = seed(env);
    if (mode === "fresh") {
      await closeOpenClawStateDatabaseAsync();
    }
    const calls = watchNativeSql();
    const startedAt = performance.now();
    expect(await loadMcpToolGrants("main", { env })).toEqual([grant]);
    expect(await loadMcpToolGrants("other", { env })).toEqual([]);
    expect(await loadMcpToolGrants("*", { env })).toEqual([]);
    const callerSqlCalls = calls.count();
    console.info("exec policy read", {
      mode,
      callerSqlCalls,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    expect(callerSqlCalls).toBe(0);
    expect(source.db.isOpen).toBe(mode === "cached");
  },
);

it("keeps a captured source when its caller changes the environment", async () => {
  const original = fixture();
  const foreign = fixture();
  seed(original.env);
  seed(foreign.env, "foreign-tool");
  const loaded = loadMcpToolGrants("main", { env: original.env });
  original.env.OPENCLAW_STATE_DIR = foreign.root;
  expect(await loaded).toEqual([grant]);
});

it("reads current policy on the next call while inherited snapshots retain their original rows", async () => {
  const { env } = fixture();
  seed(env);
  await withOpenClawStateDatabaseReadSnapshot(
    async () => {
      seed(env, "updated-tool");
      const calls = watchNativeSql();
      try {
        expect(await loadMcpToolGrants("main", { env })).toEqual([grant]);
        expect(calls.count()).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    },
    { env },
  );
  expect(await loadMcpToolGrants("main", { env })).toEqual([{ ...grant, tool: "updated-tool" }]);
});

it("binds assessment revisions to both policy bytes and their database owner", async () => {
  const original = fixture();
  const foreign = fixture();
  seed(original.env);
  seed(foreign.env);
  const first = await readExecApprovalsPolicyReadOnlyAsync({ env: original.env });
  expect(first.revision).toBeTypeOf("string");
  expect((await readExecApprovalsPolicyReadOnlyAsync({ env: original.env })).revision).toBe(
    first.revision,
  );
  expect((await readExecApprovalsPolicyReadOnlyAsync({ env: foreign.env })).revision).not.toBe(
    first.revision,
  );
  seed(original.env, "changed-tool");
  expect((await readExecApprovalsPolicyReadOnlyAsync({ env: original.env })).revision).not.toBe(
    first.revision,
  );
});

it("joins an admitted policy read before its disposable source is released", async () => {
  const { env, databasePath } = fixture();
  seed(env);
  let outcome: unknown;
  await withDisposableOpenClawStateReads(databasePath, async () => {
    void loadMcpToolGrants("main", { env }).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );
  });
  expect(outcome).toEqual([grant]);
});

it.each(["missing-database", "missing-row"] as const)(
  "preserves noncreating %s reads",
  async (mode) => {
    const { env, databasePath } = fixture();
    if (mode === "missing-row") {
      openOpenClawStateDatabase({ env });
    }
    expect(await loadMcpToolGrants("main", { env })).toEqual([]);
    expect((await loadExecApprovalsReadOnlyAsync({ env })).defaults?.security).toBeUndefined();
    expect(fs.existsSync(databasePath)).toBe(mode === "missing-row");
  },
);

it.each(["{not-json", '{"version":1,"agents":{"__proto__":{"security":42}}}'])(
  "fails closed and retains host warning throttling for malformed policy %s",
  async (raw) => {
    const { env } = fixture();
    seed(env, grant.tool, raw);
    expect(await loadMcpToolGrants("main", { env })).toEqual([]);
    expect((await loadExecApprovalsReadOnlyAsync({ env })).defaults).toMatchObject({
      security: "deny",
      ask: "off",
    });
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(loggerWarn.mock.calls[0]?.[0]).toContain("malformed");
  },
);

it.each(["", ".doctor-importing"])("preserves the typed legacy gate for %s", async (suffix) => {
  const { root, env, databasePath } = fixture();
  const legacy = path.join(root, `exec-approvals.json${suffix}`);
  fs.writeFileSync(legacy, "{}");
  await expect(loadMcpToolGrants("main", { env })).rejects.toBeInstanceOf(
    ExecApprovalsMigrationRequiredError,
  );
  expect(fs.existsSync(databasePath)).toBe(false);
  fs.rmSync(legacy);
  expect(await loadMcpToolGrants("main", { env })).toEqual([]);
});

it("fails closed without a native retry when the worker read fails", async () => {
  const { env } = fixture();
  seed(env);
  vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockRejectedValue(
    new Error("fixture reader failed"),
  );
  const calls = watchNativeSql();
  expect(await loadMcpToolGrants("main", { env })).toEqual([]);
  expect((await loadExecApprovalsReadOnlyAsync({ env })).defaults?.security).toBe("deny");
  expect((await readExecApprovalsPolicyReadOnlyAsync({ env })).revision).toBeUndefined();
  expect(calls.count()).toBe(0);
  expect(loggerWarn).toHaveBeenCalledTimes(1);
  expect(loggerWarn.mock.calls[0]?.[0]).toContain("unavailable");
});

function prepareCronPolicy(env: NodeJS.ProcessEnv) {
  return prepareCronExecHostPolicyUse(captureOpenClawStateWorkerContext({ env }), {
    agentId: "main",
    security: "allowlist",
    ask: "on-miss",
  });
}

it.each(["commit", "rollback", "unknown commit"] as const)(
  "retires only the prepared cron policy use across a native %s",
  async (outcome) => {
    const { root, env } = fixture();
    const source = seed(env);
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const use = await prepareCronPolicy(env);
    const sql = watchNativeSql();
    expect(use.assertCurrent).not.toThrow();
    sql.expectIdle();
    sql.restore();
    const exec = source.db.exec.bind(source.db);
    const failure =
      outcome === "unknown commit"
        ? vi.spyOn(source.db, "exec").mockImplementation((statement) => {
            exec(statement);
            if (statement === "COMMIT") {
              throw new Error("synthetic lost commit acknowledgement");
            }
          })
        : undefined;
    const write = () =>
      runOpenClawStateWriteTransaction(() => {
        updateExecApprovalsForMaintenance({
          update: (file) => ({ ...file, defaults: { ask: "always" } }),
        });
        expect(use.assertCurrent).toThrow("policy changed");
        if (outcome === "rollback") {
          throw new Error("synthetic rollback");
        }
      });
    try {
      if (outcome === "commit") {
        write();
      } else {
        expect(write).toThrow();
      }
      expect(use.assertCurrent).toThrow();
    } finally {
      failure?.mockRestore();
      use.release();
    }
    if (outcome === "rollback") {
      const fresh = await prepareCronPolicy(env);
      expect(fresh.assertCurrent).not.toThrow();
      fresh.release();
    }
  },
);

it("never revives an old policy use when a worker commit outruns its prepared read", async () => {
  const { root, env } = fixture();
  seed(env);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const reached = createDeferred();
  const deliver = createDeferred();
  const read = stateReads.executeExistingOpenClawStateRead;
  const held = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      reached.resolve();
      await deliver.promise;
      return result;
    });
  const prepared = prepareCronPolicy(env);
  const refused = expect(prepared).rejects.toThrow("policy changed");
  try {
    await awaitGateBeforeSettlement(
      reached.promise,
      prepared,
      "Policy read settled before delivery gate",
    );
    await updateExecApprovals({
      update: { kind: "replace", file: { version: 1, defaults: { security: "deny" } } },
    });
    await updateExecApprovals({
      update: { kind: "replace", file: { version: 1, defaults: { security: "allowlist" } } },
    });
  } finally {
    deliver.resolve();
    held.mockRestore();
  }
  await refused;
  const fresh = await prepareCronPolicy(env);
  expect(fresh.assertCurrent).not.toThrow();
  fresh.release();
});

it("keeps cron policy uses current through real worker grant and usage writes without caller SQL", async () => {
  const { root, env } = fixture();
  seed(env);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const initial = readExecApprovalsSnapshot().file;
  prepareExecApprovalsCurrentRead(captureOpenClawStateWorkerContext({ env }));
  const sql = watchNativeSql();
  sql.calibrate();
  const use = await prepareCronPolicy(env);
  try {
    await commitExecAuthorizationLocked({
      agentId: "main",
      matches: [],
      command: "echo policy-neutral",
      authorization: {
        source: "explicit-approval",
        security: "allowlist",
        ask: "on-miss",
        allowlistSatisfied: false,
        policySnapshot: createExecApprovalPolicySnapshot({ file: initial, agentId: "main" }),
      },
      allowAlwaysDecision: { kind: "exact-command", commandText: "echo policy-neutral" },
    });
    const file = await loadExecApprovalsReadOnlyAsync({ env });
    const matches = file.agents?.main?.allowlist ?? [];
    expect(matches).toHaveLength(1);
    await commitExecAuthorizationLocked({
      agentId: "main",
      matches,
      command: "echo policy-neutral",
      authorization: {
        source: "current-policy",
        security: "allowlist",
        ask: "on-miss",
        allowlistSatisfied: true,
      },
    });
    expect(use.assertCurrent).not.toThrow();
    sql.expectIdle();
  } finally {
    use.release();
    sql.restore();
  }
});

it("publishes native restoration and scopes policy retirement to the original physical source", async () => {
  const { root, env } = fixture();
  seed(env);
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const original = readExecApprovalsSnapshot();
  updateExecApprovalsForMaintenance({
    update: (file) => ({ ...file, defaults: { ask: "always" } }),
  });
  const denied = readExecApprovalsSnapshot();
  await restoreExecApprovalsSnapshotLocked(original, denied.hash);
  const use = await prepareCronPolicy(env);
  const foreign = fixture();
  seed(foreign.env);
  vi.stubEnv("OPENCLAW_STATE_DIR", foreign.root);
  updateExecApprovalsForMaintenance({
    update: (file) => ({ ...file, defaults: { security: "deny" } }),
  });
  expect(use.assertCurrent).not.toThrow();
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  await restoreExecApprovalsSnapshotLocked(denied, original.hash);
  expect(use.assertCurrent).toThrow("policy changed");
  use.release();
});

it("releases prepared policy observations on database close without reviving them on reopen", async () => {
  const { env } = fixture();
  seed(env);
  const use = await prepareCronPolicy(env);
  await closeOpenClawStateDatabaseAsync();
  expect(use.assertCurrent).toThrow();
  openOpenClawStateDatabase({ env });
  const fresh = await prepareCronPolicy(env);
  expect(fresh.assertCurrent).not.toThrow();
  expect(use.assertCurrent).toThrow();
  fresh.release();
});

it.each(["fulfilled", "throwing launch", "unknown"] as const)(
  "retains the policy mutation fence through a %s native acknowledgement",
  async (outcome) => {
    const { root, env } = fixture();
    seed(env);
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const use = await prepareCronPolicy(env);
    const acknowledgement = createDeferred();
    const deny = () =>
      updateExecApprovalsForMaintenance({
        update: (file) => ({ ...file, defaults: { security: "deny" } }),
      });
    const launch = vi.fn(() => {
      if (outcome === "throwing launch") {
        throw new Error("synthetic native launch failure");
      }
    });
    try {
      if (outcome === "throwing launch") {
        expect(() => use.initiate(launch, acknowledgement.promise)).toThrow(
          "synthetic native launch failure",
        );
      } else {
        use.initiate(launch, acknowledgement.promise);
      }
      expect(launch).toHaveBeenCalledOnce();
      use.release();
      expect(deny).toThrow("native launch acknowledgement is pending");
      expect(
        updateExecApprovalsForMaintenance({
          update: (file) => ({ ...file, socket: { path: "/synthetic-metadata" } }),
        }),
      ).not.toBeNull();
      expect((await loadExecApprovalsReadOnlyAsync({ env })).defaults?.security).not.toBe("deny");
      if (outcome === "unknown") {
        acknowledgement.reject(new Error("synthetic native outcome unknown"));
        await acknowledgement.promise.catch(() => {});
        expect(deny).toThrow("native launch acknowledgement is pending");
        await closeOpenClawStateDatabaseAsync();
        expect(deny()).not.toBeNull();
      } else {
        acknowledgement.resolve();
        await acknowledgement.promise;
        expect(deny()).not.toBeNull();
      }
      expect((await loadExecApprovalsReadOnlyAsync({ env })).defaults?.security).toBe("deny");
    } finally {
      acknowledgement.resolve();
      use.release();
    }
  },
);
