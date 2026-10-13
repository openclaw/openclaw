// Doctor state migration tests cover legacy state moves, archive markers, and repair behavior.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildAcpDatabaseSessionKey } from "../acp/runtime/session-meta-keys.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  autoMigrateLegacyState as autoMigrateLegacyStateWithSurfaces,
  detectLegacyStateMigrations as detectLegacyStateMigrationsWithSurfaces,
  runLegacyStateMigrations as runLegacyStateMigrationsWithSurfaces,
} from "../infra/state-migrations.doctor.js";
import { writeLegacySessionsFixture } from "../infra/state-migrations.session-store.test-support.js";
import { resetAutoMigrateLegacyStateDirForTest } from "../infra/state-migrations.state-dir.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "../plugin-state/plugin-state-store.test-helpers.js";
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

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    resetAutoMigrateLegacyStateDirForTest();
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

type DetectLegacyStateParams = Parameters<typeof detectLegacyStateMigrationsWithSurfaces>[0];
type RunLegacyStateParams = Parameters<typeof runLegacyStateMigrationsWithSurfaces>[0];
type AutoMigrateLegacyStateParams = Parameters<typeof autoMigrateLegacyStateWithSurfaces>[0];

// This broad core suite intentionally exercises migration mechanics without plugin-owned keys.
// Package-shaped coverage owns configured plugin resolution and setup-sidecar loading.
function detectLegacyStateMigrations(
  params: Omit<DetectLegacyStateParams, "legacySessionSurfaces">,
) {
  return detectLegacyStateMigrationsWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

function runLegacyStateMigrations(params: Omit<RunLegacyStateParams, "legacySessionSurfaces">) {
  return runLegacyStateMigrationsWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

function autoMigrateLegacyState(
  params: Omit<AutoMigrateLegacyStateParams, "legacySessionSurfaces">,
) {
  return autoMigrateLegacyStateWithSurfaces({
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

const mockedChannelMigrationPlans = vi.hoisted(() => ({
  plans: [] as Array<Record<string, unknown>>,
}));
const mockedLegacyMigrationDetectors = vi.hoisted(() => ({
  entries: [] as Array<{
    pluginId: string;
    detector: (params: {
      cfg: OpenClawConfig;
      env: NodeJS.ProcessEnv;
      stateDir: string;
      oauthDir: string;
    }) => Array<Record<string, unknown>>;
  }>,
}));

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  mockedLegacyMigrationDetectors.entries = [
    {
      pluginId: "test-channel",
      detector: () => mockedChannelMigrationPlans.plans,
    },
  ];
  return {
    ...actual,
  };
});

vi.mock("../config/sessions.js", () => ({
  saveSessionStore: async (storePath: string, store: Record<string, unknown>) => {
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    await fs.promises.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  },
}));

vi.mock("../infra/json-files.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/json-files.js")>("../infra/json-files.js");
  return {
    ...actual,
    writeTextAtomic: async (
      filePath: string,
      content: string,
      options?: { mode?: number; dirMode?: number; trailingNewline?: boolean },
    ) => {
      const payload =
        options?.trailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
      await fs.promises.mkdir(path.dirname(filePath), {
        recursive: true,
        ...(typeof options?.dirMode === "number" ? { mode: options.dirMode } : {}),
      });
      await fs.promises.writeFile(filePath, payload, {
        encoding: "utf8",
        mode: options?.mode ?? 0o600,
      });
    },
  };
});

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
      knownPluginIds: mockedLegacyMigrationDetectors.entries.map(({ pluginId }) => pluginId),
      sessionStoreOwnerPluginIds: [],
      descriptors: mockedLegacyMigrationDetectors.entries.map(({ pluginId }) => ({
        pluginId,
        id: `${pluginId}-legacy-channel-state`,
      })),
      unresolvedPluginIds: [],
    })),
    listPluginDoctorStateMigrationEntries: vi.fn(() =>
      mockedLegacyMigrationDetectors.entries.map(({ pluginId, detector }) => ({
        pluginId,
        migration: definePluginDoctorMigrationFromPlans({
          id: `${pluginId}-legacy-channel-state`,
          label: `${pluginId} legacy channel state`,
          resolvePlans: detector as never,
        }),
      })),
    ),
  };
});

function writeJson5(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeLegacyDebugProxyCaptureSidecar(root: string, overrides: { blobDir?: string } = {}) {
  const sourcePath = path.join(root, "debug-proxy", "capture.sqlite");
  const blobDir = overrides.blobDir ?? path.join(root, "debug-proxy", "blobs");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(blobDir, { recursive: true });
  const payload = Buffer.from('{"legacy":true}');
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const blobId = sha256.slice(0, 24);
  fs.writeFileSync(path.join(blobDir, `${blobId}.bin.gz`), gzipSync(payload));
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(sourcePath);
  try {
    db.exec(`
      CREATE TABLE capture_sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        mode TEXT NOT NULL,
        source_scope TEXT NOT NULL,
        source_process TEXT NOT NULL,
        proxy_url TEXT,
        db_path TEXT NOT NULL,
        blob_dir TEXT NOT NULL
      );
      CREATE TABLE capture_events (
        id INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        source_scope TEXT NOT NULL,
        source_process TEXT NOT NULL,
        protocol TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        flow_id TEXT NOT NULL,
        method TEXT,
        host TEXT,
        path TEXT,
        status INTEGER,
        close_code INTEGER,
        content_type TEXT,
        headers_json TEXT,
        data_text TEXT,
        data_blob_id TEXT,
        data_sha256 TEXT,
        error_text TEXT,
        meta_json TEXT
      );
    `);
    db.prepare(
      `INSERT INTO capture_sessions (
        id, started_at, ended_at, mode, source_scope, source_process, proxy_url, db_path, blob_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-session",
      100,
      200,
      "proxy-run",
      "openclaw",
      "openclaw",
      "http://127.0.0.1:8080",
      sourcePath,
      blobDir,
    );
    db.prepare(
      `INSERT INTO capture_events (
        session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
        method, host, path, status, close_code, content_type, headers_json, data_text,
        data_blob_id, data_sha256, error_text, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-session",
      150,
      "openclaw",
      "openclaw",
      "https",
      "outbound",
      "request",
      "legacy-flow",
      "POST",
      "api.example.com",
      "/v1/test",
      null,
      null,
      "application/json",
      '{"content-type":"application/json"}',
      '{"legacy":true}',
      blobId,
      sha256,
      null,
      '{"provider":"test"}',
    );
  } finally {
    db.close();
  }
  return { sourcePath, blobDir, blobId };
}

async function runLegacyStateMigrationsForRoot(root: string, now?: () => number) {
  const detected = await detectLegacyStateMigrations({
    cfg: {},
    env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
  });
  return await runLegacyStateMigrations({ detected, now });
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

async function withStateDir<T>(root: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previous;
    }
  }
}

describe("doctor legacy state migrations", () => {
  it("records fresh shared auth ownership without reporting a relocation", async () => {
    const stateDir = makeDoctorStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

    const result = await autoMigrateLegacyState({
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
          acp: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "codex-discord",
            mode: "persistent",
            state: "idle",
            lastActivityAt: 123,
          },
        },
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      now: () => 456,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.some((change) => change.includes("ACP session metadata"))).toBe(true);
    const store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
    expect(store[legacySessionKey]?.acp).toBeUndefined();

    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    try {
      const row = db
        .prepare(
          "SELECT backend, agent, runtime_session_name, mode, state, last_activity_at FROM acp_sessions WHERE session_key = ?",
        )
        .get(buildAcpDatabaseSessionKey(sessionKey, "ops")) as
        | {
            backend: string;
            agent: string;
            runtime_session_name: string;
            mode: string;
            state: string;
            last_activity_at: number | bigint;
          }
        | undefined;
      expect(row).toMatchObject({
        backend: "acpx",
        agent: "codex",
        runtime_session_name: "codex-discord",
        mode: "persistent",
        state: "idle",
      });
      expect(Number(row?.last_activity_at)).toBe(123);
    } finally {
      db.close();
    }
  });

  it("skips symlinked custom agent-store ACP metadata stores", async () => {
    const root = makeDoctorStateDir();
    const customRoot = makeDoctorStateDir();
    const outsideRoot = makeDoctorStateDir();
    const sessionKey = "agent:main:acp:binding:discord:default:feedface";
    const cfg: OpenClawConfig = {
      session: {
        store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    };
    const managedStorePath = path.join(customRoot, "agents", "main", "sessions", "sessions.json");
    const outsideStorePath = path.join(outsideRoot, "sessions.json");
    writeJson5(outsideStorePath, {
      [sessionKey]: {
        sessionId: "sess-acp",
        updatedAt: 100,
        acp: {
          backend: "acpx",
          agent: "codex",
          runtimeSessionName: "codex-discord",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 123,
        },
      },
    });
    fs.mkdirSync(path.dirname(managedStorePath), { recursive: true });
    fs.symlinkSync(outsideStorePath, managedStorePath);

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes.some((change) => change.includes("ACP session metadata"))).toBe(false);
    const outsideStore = JSON.parse(fs.readFileSync(outsideStorePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    expect(outsideStore[sessionKey]?.acp).toBeDefined();
  });

  it("preserves legacy creation times so later live writes evict migrated rows before fresher existing rows", async () => {
    const root = makeDoctorStateDir();
    const sourcePath = path.join(root, "legacy-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test recency cache",
        sourcePath,
        targetPath: "plugin state:test.recency-cache",
        pluginId: "telegram",
        namespace: "test.recency-cache",
        maxEntries: 2,
        scopeKey: "",
        cleanupSource: "rename",
        readEntries: () => [
          { key: "legacy-old", value: { body: "old" }, timestamp: 1_000 },
          { key: "legacy-new", value: { body: "new" }, timestamp: 2_000 },
        ],
      },
    ];

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.recency-cache",
        maxEntries: 2,
      });
      await store.register("current", { body: "current" });
    });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const result = await runLegacyStateMigrationsForRoot(root);
    expect(result.changes).toStrictEqual(["Migrated 1 Test recency cache entry → plugin state"]);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.recency-cache",
        maxEntries: 2,
      });
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
    const sourcePath = path.join(root, "legacy-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test deferred cache",
        sourcePath,
        targetPath: "plugin state:test.deferred-cache",
        pluginId: "telegram",
        namespace: "test.deferred-cache",
        maxEntries: 2,
        scopeKey: "",
        cleanupSource: "rename",
        readEntries: () => [
          { key: "legacy-old", value: { body: "old" }, timestamp: 1_000 },
          { key: "legacy-new", value: { body: "new" }, timestamp: 2_000 },
        ],
      },
    ];

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.deferred-cache",
        maxEntries: 2,
      });
      await store.register("current", { body: "current" });
    });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const firstDetected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const firstResult = await runLegacyStateMigrations({ detected: firstDetected });
    expect(firstResult.changes).toContain("Migrated 1 Test deferred cache entry → plugin state");
    expect(fs.existsSync(sourcePath)).toBe(true);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.deferred-cache",
        maxEntries: 2,
      });
      expect(await store.lookup("current")).toStrictEqual({ body: "current" });
      expect(await store.lookup("legacy-new")).toStrictEqual({ body: "new" });
      expect(await store.lookup("legacy-old")).toBeUndefined();
      await store.delete("current");
    });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const secondDetected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    const secondResult = await runLegacyStateMigrations({ detected: secondDetected });

    expect(secondResult.warnings).toStrictEqual([]);
    expect(secondResult.changes).toContain("Migrated 1 Test deferred cache entry → plugin state");
    expect(secondResult.changes).toContain(
      `Archived Test deferred cache legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.deferred-cache",
        maxEntries: 2,
      });
      expect(await store.lookup("legacy-new")).toStrictEqual({ body: "new" });
      expect(await store.lookup("legacy-old")).toStrictEqual({ body: "old" });
    });
  });

  it("keeps already-imported entries when a concurrent namespace write causes eviction", async () => {
    const root = makeDoctorStateDir();
    const maxEntries = 4;
    const sourcePath = path.join(root, "legacy-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test evicted cache",
        sourcePath,
        targetPath: "plugin state:test.evicted-cache",
        pluginId: "telegram",
        namespace: "test.evicted-cache",
        maxEntries,
        scopeKey: "scope",
        cleanupSource: "rename",
        // Seeding inside readEntries lands after the preflight capacity check, which
        // simulates concurrent live writes filling the namespace before import.
        readEntries: () => {
          seedPluginStateEntriesForTests(
            Array.from({ length: maxEntries - 2 }, (_, index) => ({
              pluginId: "telegram",
              namespace: "test.evicted-cache",
              key: `concurrent-${index}`,
              value: { body: "concurrent" },
            })),
          );
          return [
            { key: "first", value: { body: "first" }, timestamp: 1_000 },
            { key: "second", value: { body: "second" }, timestamp: 2_000 },
            { key: "third", value: { body: "third" }, timestamp: 3_000 },
          ];
        },
      },
    ];

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([
      "Paused migrating Test evicted cache because plugin state cap evicted scope:first; imported 1 of 3 missing entries and deferred the rest in the legacy source",
    ]);
    expect(result.changes).toContain("Migrated 1 Test evicted cache entry → plugin state");
    expect(result.changes).not.toContain(
      `Archived Test evicted cache legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.evicted-cache",
        maxEntries,
      });
      const valuesByKey = new Map(
        (await store.entries()).map(({ key, value }) => [key, value.body]),
      );
      expect(valuesByKey.has("scope:first")).toBe(false);
      expect(valuesByKey.get("scope:second")).toBe("second");
      expect(valuesByKey.has("scope:third")).toBe(false);
      expect(valuesByKey.get("concurrent-0")).toBe("concurrent");
      expect(valuesByKey.get("concurrent-1")).toBe("concurrent");
    });
  });

  it("preserves duplicate debug proxy events and retry idempotency", async () => {
    const root = makeDoctorStateDir();
    const { sourcePath } = writeLegacyDebugProxyCaptureSidecar(root);
    const sqlite = requireNodeSqlite();
    const legacyDb = new sqlite.DatabaseSync(sourcePath);
    try {
      legacyDb.exec(`
        INSERT INTO capture_events (
          session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
          method, host, path, status, close_code, content_type, headers_json, data_text,
          data_blob_id, data_sha256, error_text, meta_json
        )
        SELECT
          session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
          method, host, path, status, close_code, content_type, headers_json, data_text,
          data_blob_id, data_sha256, error_text, meta_json
        FROM capture_events
        LIMIT 1;
      `);
    } finally {
      legacyDb.close();
    }
    const rename = failRenameOnce(sourcePath);
    const firstResult = await (async () => {
      try {
        return await runLegacyStateMigrationsForRoot(root);
      } finally {
        rename.mockRestore();
      }
    })();

    expect(firstResult.warnings).toStrictEqual([
      `Failed archiving debug proxy capture sidecar ${sourcePath}: Error: forced archive failure`,
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    const retryResult = await runLegacyStateMigrationsForRoot(root);

    expect(retryResult.warnings).toStrictEqual([]);
    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
      count: 2,
    });
  });

  it("retries debug proxy blob archival without duplicating imported events", async () => {
    const root = makeDoctorStateDir();
    const { sourcePath, blobDir } = writeLegacyDebugProxyCaptureSidecar(root);
    const rename = failRenameOnce(blobDir);
    const firstResult = await (async () => {
      try {
        return await runLegacyStateMigrationsForRoot(root);
      } finally {
        rename.mockRestore();
      }
    })();

    expect(firstResult.warnings).toStrictEqual([
      `Failed archiving debug proxy capture blobs ${blobDir}: Error: forced archive failure`,
    ]);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(blobDir)).toBe(true);

    const retryDetected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(retryDetected.debugProxyCaptureSidecar.hasLegacy).toBe(true);
    const retryResult = await runLegacyStateMigrations({ detected: retryDetected });

    expect(retryResult.warnings).toStrictEqual([]);
    expect(retryResult.changes).toStrictEqual([
      `Archived debug proxy capture blobs → ${blobDir}.migrated`,
    ]);
    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
      count: 1,
    });
  });

  it("never imports default exec approvals into a custom state dir", async () => {
    // Regression: every custom state root is an independent trust scope.
    // Even direct doctor repair must not copy or archive default approvals.
    const root = makeDoctorStateDir();
    const stateDir = path.join(root, "custom-state");
    const sourcePath = path.join(root, ".openclaw", "exec-approvals.json");
    const targetPath = path.join(stateDir, "exec-approvals.json");
    writeJson5(sourcePath, {
      version: 1,
      socket: {
        token: "legacy-token",
      },
      defaults: {
        security: "deny",
        ask: "always",
      },
    });
    const sourceRaw = fs.readFileSync(sourcePath, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => root,
    });
    expect(detected.preview.some((entry) => entry.includes("Exec approvals"))).toBe(false);

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).not.toContain(`Migrated exec approvals → ${targetPath}`);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceRaw);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("keeps default exec approvals in place during automatic state migration", async () => {
    const root = makeDoctorStateDir();
    const stateDir = path.join(root, "custom-state");
    const sourcePath = path.join(root, ".openclaw", "exec-approvals.json");
    const targetPath = path.join(stateDir, "exec-approvals.json");
    writeJson5(sourcePath, {
      version: 1,
      socket: {
        token: "legacy-token",
      },
      defaults: {
        security: "deny",
      },
    });
    const sourceRaw = fs.readFileSync(sourcePath, "utf8");

    const result = await autoMigrateLegacyState({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv,
      homedir: () => root,
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).not.toContain(`Migrated exec approvals → ${targetPath}`);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceRaw);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
    expect(fs.existsSync(targetPath)).toBe(false);
  });
});
