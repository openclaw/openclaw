import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
} from "../state/openclaw-state-db.js";
import { commitExecAuthorizationLocked } from "./exec-approvals-authorization.js";
import { loadMcpToolGrants } from "./exec-approvals-mcp.js";
import { ExecApprovalsMigrationRequiredError } from "./exec-approvals-migration-gate.js";
import { writeExecApprovalsConfigRow } from "./exec-approvals-sqlite.js";
import {
  loadExecApprovalsReadOnlyAsync,
  readExecApprovalsPolicyReadOnlyAsync,
} from "./exec-approvals-store.js";
import { testing } from "./exec-approvals-store.test-support.js";
import { requireNodeSqlite } from "./node-sqlite.js";

const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: (name: string) => ({
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
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  return [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    ),
  ];
}

it("commits unchanged authorization without main-thread SQLite and keeps its captured policy owner", async () => {
  const { root, env } = fixture();
  seed(env);
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
  expect(calls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(0);
  vi.restoreAllMocks();
  expect(assertCurrent).not.toThrow();
  writeExecApprovalsConfigRow({
    db: openOpenClawStateDatabase({ env }).db,
    file: { version: 1, defaults: { security: "deny" } },
  });
  expect(assertCurrent).toThrow("Exec approval changed before execution");
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
  expect(calls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(0);
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
    const callerSqlCalls = calls.reduce((total, call) => total + call.mock.calls.length, 0);
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
        expect(calls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(0);
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
  expect(calls.reduce((total, call) => total + call.mock.calls.length, 0)).toBe(0);
  expect(loggerWarn).toHaveBeenCalledTimes(1);
  expect(loggerWarn.mock.calls[0]?.[0]).toContain("unavailable");
});
