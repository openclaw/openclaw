import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "../infra/state-migrations.doctor.js";
import { writeLegacySessionsFixture } from "../infra/state-migrations.session-store.test-support.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    resetPluginStateStoreForTests();
    mockedChannelMigrationPlans.plans = [];
    cleanup();
  }),
);

function makeDoctorStateDir(): string {
  return tempDirs.make("openclaw-doctor-");
}

// Migration mechanics are independent of plugin-owned session keys.
const coreSurfaces = { legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES };

const mockedChannelMigrationPlans = vi.hoisted(() => ({
  plans: [] as ChannelLegacyStateMigrationPlan[],
}));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  const { definePluginDoctorMigrationFromPlans } = await vi.importActual<
    typeof import("../plugin-sdk/runtime-doctor-migrations.js")
  >("../plugin-sdk/runtime-doctor-migrations.js");
  return {
    ...actual,
    collectRelevantDoctorPluginIds: vi.fn(() => []),
    listPluginDoctorSessionStoreAgentIds: vi.fn(() => []),
    resolveLivePluginDoctorStateMigrationInventory: vi.fn(() => ({
      knownPluginIds: ["test-channel"],
      sessionStoreOwnerPluginIds: [],
      descriptors: [{ pluginId: "test-channel", id: "test-channel-legacy-channel-state" }],
      unresolvedPluginIds: [],
    })),
    listPluginDoctorStateMigrationEntries: vi.fn(() => [
      {
        pluginId: "test-channel",
        migration: definePluginDoctorMigrationFromPlans({
          id: "test-channel-legacy-channel-state",
          label: "test-channel legacy channel state",
          resolvePlans: () => mockedChannelMigrationPlans.plans,
        }),
      },
    ]),
  };
});

function writeJson5(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeLegacyDebugProxyCaptureSidecar(root: string, eventCount: number) {
  const sourcePath = path.join(root, "debug-proxy", "capture.sqlite");
  const blobDir = path.join(root, "debug-proxy", "blobs");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(blobDir, { recursive: true });
  const payload = Buffer.from('{"legacy":true}');
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const blobId = sha256.slice(0, 24);
  fs.writeFileSync(path.join(blobDir, `${blobId}.bin.gz`), gzipSync(payload));
  const sqlite = requireNodeSqlite();
  using db = new sqlite.DatabaseSync(sourcePath);
  db.exec(`
      CREATE TABLE capture_sessions (
        id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER,
        mode TEXT NOT NULL, source_scope TEXT NOT NULL, source_process TEXT NOT NULL,
        proxy_url TEXT, db_path TEXT NOT NULL, blob_dir TEXT NOT NULL
      );
      CREATE TABLE capture_events (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL,
        source_scope TEXT NOT NULL, source_process TEXT NOT NULL, protocol TEXT NOT NULL,
        direction TEXT NOT NULL, kind TEXT NOT NULL, flow_id TEXT NOT NULL,
        method TEXT, host TEXT, path TEXT, status INTEGER, close_code INTEGER,
        content_type TEXT, headers_json TEXT, data_text TEXT, data_blob_id TEXT,
        data_sha256 TEXT, error_text TEXT, meta_json TEXT
      );
    `);
  db.prepare(
    `INSERT INTO capture_sessions (
        id, started_at, ended_at, mode, source_scope, source_process, proxy_url, db_path, blob_dir
      ) VALUES ('legacy-session', 100, 200, 'proxy-run', 'openclaw', 'openclaw',
        'http://127.0.0.1:8080', ?, ?)`,
  ).run(sourcePath, blobDir);
  const insertEvent = db.prepare(
    `INSERT INTO capture_events (
        session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
        method, host, path, status, close_code, content_type, headers_json, data_text,
        data_blob_id, data_sha256, error_text, meta_json
      ) VALUES ('legacy-session', 150, 'openclaw', 'openclaw', 'https', 'outbound',
        'request', 'legacy-flow', 'POST', 'api.example.com', '/v1/test', NULL, NULL,
        'application/json', '{"content-type":"application/json"}', '{"legacy":true}',
        ?, ?, NULL, '{"provider":"test"}')`,
  );
  for (let index = 0; index < eventCount; index++) {
    insertEvent.run(blobId, sha256);
  }
  return { sourcePath, blobDir, blobId };
}

async function runLegacyStateMigrationsForRoot(root: string, now?: () => number) {
  const detected = await detectLegacyStateMigrations({
    ...coreSurfaces,
    cfg: {},
    env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
  });
  return await runLegacyStateMigrations({ ...coreSurfaces, detected, now });
}

function failRenameOnce(sourcePath: string) {
  const actualRenameSync = fs.renameSync.bind(fs);
  let failed = false;
  return vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (!failed && String(from) === sourcePath) {
      failed = true;
      throw new Error("forced archive failure");
    }
    actualRenameSync(from, to);
  });
}

const legacyAcp = {
  backend: "acpx",
  agent: "codex",
  runtimeSessionName: "codex-discord",
  mode: "persistent",
  state: "idle",
  lastActivityAt: 123,
};

async function seedLegacyCache(root: string, kind: "recency" | "deferred") {
  const sourcePath = path.join(root, "legacy-cache.json");
  const namespace = `test.${kind}-cache`;
  fs.writeFileSync(sourcePath, "legacy", "utf-8");
  mockedChannelMigrationPlans.plans = [
    {
      kind: "plugin-state-import",
      label: `Test ${kind} cache`,
      sourcePath,
      targetPath: `plugin state:${namespace}`,
      pluginId: "telegram",
      namespace,
      maxEntries: 2,
      scopeKey: "",
      cleanupSource: "rename",
      readEntries: () => [
        { key: "legacy-old", value: { body: "old" }, timestamp: 1_000 },
        { key: "legacy-new", value: { body: "new" }, timestamp: 2_000 },
      ],
    },
  ];
  const withCache = <T>(
    run: (store: ReturnType<typeof createPluginStateKeyedStore<{ body: string }>>) => Promise<T>,
  ) =>
    withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      try {
        return await run(
          createPluginStateKeyedStore<{ body: string }>("telegram", { namespace, maxEntries: 2 }),
        );
      } finally {
        await closeOpenClawStateDatabaseAsync();
        resetPluginStateStoreForTests();
      }
    });
  await withCache((store) => store.register("current", { body: "current" }));
  return { sourcePath, withCache };
}

async function migrateWithArchiveFailure(root: string, sourcePath: string) {
  const rename = failRenameOnce(sourcePath);
  try {
    return await runLegacyStateMigrationsForRoot(root);
  } finally {
    rename.mockRestore();
  }
}

function seedExecApprovals(ask = false) {
  const root = makeDoctorStateDir();
  const stateDir = path.join(root, "custom-state");
  const sourcePath = path.join(root, ".openclaw", "exec-approvals.json");
  const targetPath = path.join(stateDir, "exec-approvals.json");
  writeJson5(sourcePath, {
    version: 1,
    socket: { token: "legacy-token" },
    defaults: { security: "deny", ...(ask ? { ask: "always" } : {}) },
  });
  return { root, stateDir, sourcePath, targetPath, sourceRaw: fs.readFileSync(sourcePath, "utf8") };
}

function expectApprovalsUntouched(fixture: ReturnType<typeof seedExecApprovals>) {
  expect(fs.readFileSync(fixture.sourcePath, "utf8")).toBe(fixture.sourceRaw);
  expect(fs.existsSync(`${fixture.sourcePath}.migrated`)).toBe(false);
  expect(fs.existsSync(fixture.targetPath)).toBe(false);
}

describe("doctor legacy state migrations", () => {
  it("records fresh shared auth ownership without reporting a relocation", async () => {
    const stateDir = makeDoctorStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    const result = await autoMigrateLegacyState({
      ...coreSurfaces,
      cfg: {},
      env,
      doctorOnlyStateMigrations: true,
    });

    expect(result.changes).not.toContain(
      "Relocated shared auth profiles into shared SQLite state.",
    );
    expect(result.notices ?? []).not.toContain(
      "The main agent no longer owns shared credentials and can now be deleted.",
    );
    const database = openOpenClawStateDatabase({ env }).db;
    expect(
      database
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = 'auth.sharedStore'")
        .get(),
    ).toEqual({ value_json: JSON.stringify({ location: "state-db" }) });
  });

  it("migrates legacy ACP metadata from retired custom-root agent stores", async () => {
    const root = makeDoctorStateDir();
    const customRoot = makeDoctorStateDir();
    const legacySessionKey = "acp:binding:discord:default:feedface";
    const sessionKey = "agent:ops:acp:binding:discord:default:feedface";
    const storePath = path.join(customRoot, "agents", "ops", "sessions", "sessions.json");
    const cfg: OpenClawConfig = {
      session: {
        store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    writeLegacySessionsFixture({
      root: path.join(customRoot, "agents", "ops"),
      sessions: {
        [legacySessionKey]: {
          sessionId: "sess-acp",
          updatedAt: 100,
          acp: legacyAcp,
        },
      },
    });

    const detected = await detectLegacyStateMigrations({
      ...coreSurfaces,
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({
      ...coreSurfaces,
      detected,
      config: cfg,
      now: () => 456,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.some((change) => change.includes("ACP session metadata"))).toBe(true);
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(store[legacySessionKey]?.acp).toBeUndefined();

    const sqlite = requireNodeSqlite();
    using db = new sqlite.DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    const row = db
      .prepare(
        "SELECT backend, agent, runtime_session_name, mode, state, last_activity_at FROM acp_sessions WHERE session_key = ?",
      )
      .get(buildAcpDatabaseSessionKey(sessionKey, "ops"));
    expect(row).toMatchObject({
      backend: "acpx",
      agent: "codex",
      runtime_session_name: "codex-discord",
      mode: "persistent",
      state: "idle",
    });
    expect(Number(row?.last_activity_at)).toBe(123);
  });

  it("preserves legacy creation times so later live writes evict migrated rows before fresher existing rows", async () => {
    const root = makeDoctorStateDir();
    const { withCache } = await seedLegacyCache(root, "recency");

    const result = await runLegacyStateMigrationsForRoot(root);
    expect(result.changes).toStrictEqual(["Migrated 1 Test recency cache entry → plugin state"]);

    await withCache(async (store) => {
      const migrated = (await store.entries()).find(({ key }) => key === "legacy-new");
      expect(migrated?.createdAt).toBe(2_000);

      // The next live write must evict the oldest logical entry (the migrated
      // legacy row), never the fresher pre-existing row.
      await store.register("after", { body: "after" });
      expect(await store.lookup("current")).toStrictEqual({ body: "current" });
      expect(await store.lookup("after")).toStrictEqual({ body: "after" });
      expect(await store.lookup("legacy-new")).toBeUndefined();
    });
  });

  it("imports deferred entries on a later run once the namespace frees capacity", async () => {
    const root = makeDoctorStateDir();
    const { sourcePath, withCache } = await seedLegacyCache(root, "deferred");
    const firstResult = await runLegacyStateMigrationsForRoot(root);
    expect(firstResult.changes).toContain("Migrated 1 Test deferred cache entry → plugin state");
    expect(fs.existsSync(sourcePath)).toBe(true);

    await withCache(async (store) => {
      expect(await store.lookup("current")).toStrictEqual({ body: "current" });
      expect(await store.lookup("legacy-new")).toStrictEqual({ body: "new" });
      expect(await store.lookup("legacy-old")).toBeUndefined();
      await store.delete("current");
    });
    const secondResult = await runLegacyStateMigrationsForRoot(root);

    expect(secondResult.warnings).toStrictEqual([]);
    expect(secondResult.changes).toContain("Migrated 1 Test deferred cache entry → plugin state");
    expect(secondResult.changes).toContain(
      `Archived Test deferred cache legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);

    await withCache(async (store) => {
      expect(await store.lookup("legacy-new")).toStrictEqual({ body: "new" });
      expect(await store.lookup("legacy-old")).toStrictEqual({ body: "old" });
    });
  });

  it.each([
    { failure: "sidecar", eventCount: 2 },
    { failure: "blobs", eventCount: 1 },
  ])(
    "retries debug proxy $failure archival without losing or duplicating events",
    async ({ failure, eventCount }) => {
      const root = makeDoctorStateDir();
      const { sourcePath, blobDir } = writeLegacyDebugProxyCaptureSidecar(root, eventCount);
      const failedPath = failure === "sidecar" ? sourcePath : blobDir;
      const firstResult = await migrateWithArchiveFailure(root, failedPath);
      expect(firstResult.warnings).toStrictEqual([
        `Failed archiving debug proxy capture ${failure} ${failedPath}: Error: forced archive failure`,
      ]);
      expect(fs.existsSync(failedPath)).toBe(true);
      if (failure === "blobs") {
        expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
      }
      const detected = await detectLegacyStateMigrations({
        ...coreSurfaces,
        cfg: {},
        env: { OPENCLAW_STATE_DIR: root },
      });
      expect(detected.debugProxyCaptureSidecar.hasLegacy).toBe(true);
      const retryResult = await runLegacyStateMigrations({ ...coreSurfaces, detected });
      expect(retryResult.warnings).toStrictEqual([]);
      if (failure === "blobs") {
        expect(retryResult.changes).toStrictEqual([
          `Archived debug proxy capture blobs → ${blobDir}.migrated`,
        ]);
      }
      const { db } = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      expect(db.prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
        count: eventCount,
      });
    },
  );

  it.each(["direct", "automatic"] as const)(
    "keeps default exec approvals outside the custom trust scope during %s migration",
    async (mode) => {
      const fixture = seedExecApprovals(mode === "direct");
      const { root, stateDir, targetPath } = fixture;
      const params = { cfg: {}, env: { OPENCLAW_STATE_DIR: stateDir }, homedir: () => root };
      let result: { warnings: string[]; changes: string[] };
      if (mode === "direct") {
        const detected = await detectLegacyStateMigrations({ ...coreSurfaces, ...params });
        expect(detected.preview.some((entry) => entry.includes("Exec approvals"))).toBe(false);
        result = await runLegacyStateMigrations({ ...coreSurfaces, detected });
      } else {
        result = await autoMigrateLegacyState({
          ...coreSurfaces,
          ...params,
          log: { info: vi.fn(), warn: vi.fn() },
        });
      }
      expect(result.warnings).toStrictEqual([]);
      expect(result.changes).not.toContain(`Migrated exec approvals → ${targetPath}`);
      expectApprovalsUntouched(fixture);
    },
  );
});
