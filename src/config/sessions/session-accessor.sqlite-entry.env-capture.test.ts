import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { patchSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type { ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type { InternalSessionEntry } from "./types.js";

const boundary = vi.hoisted(() => ({
  ready: Promise.resolve(),
  queue: vi.fn(async (_scope: ResolvedSqliteScope, run: () => Promise<unknown>) => {
    await boundary.ready;
    return await run();
  }),
  open: vi.fn((_options: OpenClawAgentDatabaseOptions) => ({})),
  commit: vi.fn((run: (database: unknown) => unknown, _options: OpenClawAgentDatabaseOptions) =>
    run({}),
  ),
  maintain: vi.fn(),
  history: vi.fn(),
}));

// This suite exercises the capture producer without opening a database or scheduling maintenance.
vi.mock("node:sqlite", () => ({
  DatabaseSync: function DatabaseSync() {
    throw new Error("native SQLite is outside this environment-capture test");
  },
}));
vi.mock("../../auto-reply/internal-turn-source.js", () => ({}));
vi.mock("../../infra/kysely-sync.js", () => ({}));
vi.mock("../../infra/sqlite-number.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-identity.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-readonly-scope.js", () => ({}));
vi.mock("../../state/openclaw-agent-db-readonly.js", () => ({}));
vi.mock("../../state/openclaw-agent-db.js", () => ({
  getOpenClawAgentDatabaseIfOpen: () => undefined,
  isIncognitoOpenClawAgentSqlitePath: () => false,
  openOpenClawAgentDatabase: boundary.open,
  resolveOpenClawAgentSqlitePath: (options: OpenClawAgentDatabaseOptions) =>
    options.path ?? `${options.env?.OPENCLAW_STATE_DIR}/${options.agentId}.sqlite`,
  runOpenClawAgentWriteTransaction: boundary.commit,
  withOpenClawAgentDatabaseAsync: async (
    _options: OpenClawAgentDatabaseOptions,
    run: () => unknown,
  ) => await run(),
}));
vi.mock("../future-version-guard.js", () => ({
  ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV: "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
}));
vi.mock("../paths.js", async () => ({
  resolveStateDir: (await import("../state-dir.js")).resolveStateDir,
}));
vi.mock("./internal-session-key.js", () => ({}));
vi.mock("./metadata.js", () => ({}));
vi.mock("./session-accessor.sqlite-entry-cache.js", () => ({}));
vi.mock("./session-accessor.sqlite-entry-equality.js", () => ({}));
vi.mock("./session-accessor.sqlite-entry-store.js", () => ({
  readSessionEntrySelectionSnapshot: () => [],
  readUnchangedLifecycleTargetSnapshot: () => [],
  writeSessionEntry: (_database: unknown, _key: string, entry: InternalSessionEntry) => entry,
}));
vi.mock("./session-accessor.sqlite-exact-read.js", () => ({}));
vi.mock("./session-accessor.sqlite-history.js", () => ({}));
vi.mock("./session-accessor.sqlite-identity.js", () => ({
  prepareSessionIdentityPublication: () => () => {},
}));
vi.mock("./session-accessor.sqlite-initial-entry.js", () => ({}));
vi.mock("./session-accessor.sqlite-maintenance-kick.js", () => ({
  kickSessionEntryMaintenanceAfterWrite: boundary.maintain,
}));
vi.mock("./session-accessor.sqlite-normalize.js", () => ({}));
vi.mock("./session-accessor.sqlite-scope.js", () => ({
  cloneSessionEntry: (entry: InternalSessionEntry) => structuredClone(entry),
  resolveSqliteScope: (scope: ResolvedSqliteScope) => scope,
  resolveSqliteTranscriptArchiveDirectory: () => "/synthetic/archive",
  runExclusiveSqliteSessionWrite: boundary.queue,
  toDatabaseOptions: (scope: ResolvedSqliteScope) => ({
    agentId: scope.agentId,
    env: scope.env,
    path: scope.path,
  }),
}));
vi.mock("./session-accessor.sqlite-status.js", () => ({}));
vi.mock("./session-canonical-key.js", () => ({ assertCanonicalSessionKeyWrite() {} }));
vi.mock("./session-entry-lineage.js", () => ({}));
vi.mock("./session-entry-provenance.js", () => ({}));
vi.mock("./session-history-eviction.js", () => ({
  kickSessionHistoryDiskBudgetMaintenance: boundary.history,
}));
vi.mock("./session-store-path.js", () => ({
  resolveSessionStorePathForScope: () => "/synthetic/store",
}));
vi.mock("./store-entry.js", () => ({}));
vi.mock("./types.js", () => ({}));

afterEach(() => {
  boundary.ready = Promise.resolve();
  vi.clearAllMocks();
});

it.each([
  {
    platform: "win32",
    key: "OpenClaw_State_Dir",
    readonlyKey: "OpenClaw_Config_Readonly",
    input: "plain",
  },
  {
    platform: "win32",
    key: "OpenClaw_State_Dir",
    readonlyKey: "OpenClaw_Config_Readonly",
    input: "precloned",
  },
  {
    platform: "linux",
    key: "OPENCLAW_STATE_DIR",
    readonlyKey: "OPENCLAW_CONFIG_READONLY",
    input: "plain",
  },
  {
    platform: "linux",
    key: "OpenClaw_State_Dir",
    readonlyKey: "OpenClaw_Config_Readonly",
    input: "plain",
  },
] as const)("retains $input session-write environment on $platform with $key", async (fixture) => {
  await withMockedPlatform(fixture.platform, async () => {
    const root = path.resolve("/synthetic/captured");
    const home = path.resolve("/synthetic/home");
    const rawEnv = {
      [fixture.key]: root,
      [fixture.readonlyKey]: "1",
      HOME: home,
      OPENCLAW_TEST_FAST: "1",
    };
    const env = fixture.input === "precloned" ? cloneEnvWithPlatformSemantics(rawEnv) : rawEnv;
    const scope = { agentId: "main", sessionKey: "agent:main:capture", env };
    const caseSensitiveMiss = fixture.platform === "linux" && fixture.key !== "OPENCLAW_STATE_DIR";
    const expectedRoot = caseSensitiveMiss ? path.join(home, ".openclaw") : root;
    const expectedReadonly = caseSensitiveMiss ? undefined : "1";
    const ready = createDeferredCore();
    boundary.ready = ready.promise;
    const update = vi.fn((entry: InternalSessionEntry) => ({ ...entry, label: "captured" }));
    const write = patchSessionEntryCore(scope, update, {
      fallbackEntry: { sessionId: "session", updatedAt: 1 },
      replaceEntry: true,
    });
    try {
      const queued = boundary.queue.mock.calls[0]?.[0];
      expect(queued?.path).toBe(`${expectedRoot}/main.sqlite`);
      expect(queued?.env?.OPENCLAW_STATE_DIR).toBe(expectedRoot);
      expect(queued?.env?.OPENCLAW_CONFIG_READONLY).toBe(expectedReadonly);
      expect(env[fixture.key]).toBe(root);
      expect(Object.keys(env)).toEqual(Object.keys(rawEnv));
      expect(update).not.toHaveBeenCalled();
      env[fixture.key] = "/synthetic/changed";
      env[fixture.readonlyKey] = "0";
      scope.env = { OPENCLAW_STATE_DIR: "/synthetic/replaced" };
      ready.resolve();
      await expect(write).resolves.toMatchObject({ sessionId: "session", label: "captured" });
      const committed = boundary.commit.mock.calls[0]?.[1];
      expect(committed?.path).toBe(`${expectedRoot}/main.sqlite`);
      expect(committed?.env?.OPENCLAW_STATE_DIR).toBe(expectedRoot);
      expect(committed?.env?.OPENCLAW_CONFIG_READONLY).toBe(expectedReadonly);
      expect(boundary.open.mock.calls[0]?.[0].env).toBe(queued?.env);
      expect(boundary.maintain.mock.calls[0]?.[0].scope.env).toBe(queued?.env);
      expect(boundary.history.mock.calls[0]?.[0].env).toBe(queued?.env);
      expect(update).toHaveBeenCalledOnce();
    } finally {
      ready.resolve();
      await write.catch(() => undefined);
    }
  });
});
