// Doctor state migration tests cover legacy state moves, archive markers, and repair behavior.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { expectDefined } from "@openclaw/normalization-core";
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
import {
  autoMigrateLegacyStateDir,
  resetAutoMigrateLegacyStateDirForTest,
} from "../infra/state-migrations.state-dir.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "../plugin-state/plugin-state-store.test-helpers.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store.js";
import type { InstalledPluginInstallRecordInfo } from "../plugins/installed-plugin-index.js";
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

async function writeExistingPluginInstallIndex(
  root: string,
  installRecords: Record<string, InstalledPluginInstallRecordInfo>,
): Promise<void> {
  await writePersistedInstalledPluginIndex(
    {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 1,
      installRecords,
      plugins: [],
      diagnostics: [],
    },
    { stateDir: root },
  );
}

function writeLegacyPluginInstallIndex(
  root: string,
  records: Record<string, InstalledPluginInstallRecordInfo>,
): string {
  const sourcePath = path.join(root, "plugins", "installs.json");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ records }), "utf8");
  return sourcePath;
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

type StateDirMigrationResult = Awaited<ReturnType<typeof autoMigrateLegacyStateDir>>;

const DIR_LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function getStateDirMigrationPaths(root: string) {
  return {
    targetDir: path.join(root, ".openclaw"),
    legacyDir: path.join(root, ".clawdbot"),
  };
}

function ensureLegacyAndTargetStateDirs(root: string) {
  const paths = getStateDirMigrationPaths(root);
  fs.mkdirSync(paths.targetDir, { recursive: true });
  fs.mkdirSync(paths.legacyDir, { recursive: true });
  return paths;
}

async function runFreshStateDirMigration(root: string) {
  resetAutoMigrateLegacyStateDirForTest();
  return autoMigrateLegacyStateDir({ env: {}, homedir: () => root });
}

function expectTargetAlreadyExistsWarning(result: StateDirMigrationResult, targetDir: string) {
  expect(result.migrated).toBe(false);
  expect(result.warnings).toEqual([
    `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
  ]);
}

function expectUnmigratedWithoutWarnings(result: StateDirMigrationResult) {
  expect(result.migrated).toBe(false);
  expect(result.warnings).toStrictEqual([]);
}

function writeLegacyAgentFiles(root: string, files: Record<string, string>) {
  const legacyAgentDir = path.join(root, "agent");
  fs.mkdirSync(legacyAgentDir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(legacyAgentDir, fileName), content, "utf-8");
  }
  return legacyAgentDir;
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

  it("does not bind stale session metadata to a colliding target transcript", async () => {
    const root = makeDoctorStateDir();
    const legacyDir = path.join(root, "sessions");
    const targetDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, "legacy.jsonl"),
      '{"type":"session","id":"other"}\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(targetDir, "legacy.legacy-123.jsonl"),
      '{"type":"session","id":"legacy"}\n',
      "utf8",
    );
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": {
        sessionId: "legacy",
        sessionFile: path.join(legacyDir, "legacy.jsonl"),
        updatedAt: 10,
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.sessions.hasLegacy).toBe(false);
    expect(detected.preview).not.toContain(
      `- Sessions: repair migrated transcript paths in ${path.join(targetDir, "sessions.json")}`,
    );
  });

  it("repairs canonical headerless legacy transcript paths", async () => {
    const root = makeDoctorStateDir();
    const legacyDir = path.join(root, "sessions");
    const targetDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "legacy.jsonl"), '{"role":"user"}\n', "utf8");
    writeJson5(path.join(targetDir, "sessions.json"), {
      "agent:main:main": {
        sessionId: "legacy",
        sessionFile: path.join(legacyDir, "legacy.jsonl"),
        updatedAt: 10,
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.sessions.hasLegacy).toBe(true);
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

  it("preserves conflicting agent files and records a recoverable quarantine", async () => {
    const root = makeDoctorStateDir();
    writeLegacyAgentFiles(root, {
      "foo.txt": "legacy",
      "baz.txt": "legacy2",
    });

    const targetAgentDir = path.join(root, "agents", "main", "agent");
    fs.mkdirSync(targetAgentDir, { recursive: true });
    fs.writeFileSync(path.join(targetAgentDir, "foo.txt"), "new", "utf-8");

    const result = await runLegacyStateMigrationsForRoot(root, () => 123);

    expect(fs.readFileSync(path.join(targetAgentDir, "baz.txt"), "utf-8")).toBe("legacy2");
    expect(fs.readFileSync(path.join(targetAgentDir, "foo.txt"), "utf-8")).toBe("new");
    const backups = fs.readdirSync(root).filter((name) => name.startsWith("agent.legacy-"));
    expect(backups).toHaveLength(1);
    const backupDir = path.join(
      fs.realpathSync(root),
      expectDefined(backups[0], "conflict quarantine"),
    );
    expect(fs.readdirSync(backupDir)).toEqual(["foo.txt"]);
    expect(fs.readFileSync(path.join(backupDir, "foo.txt"), "utf-8")).toBe("legacy");
    expect(result.stepReceipts.find((receipt) => receipt.id === "agent-dir")).toMatchObject({
      outcome: "warning",
      warnings: [expect.stringContaining(path.join(backupDir, "foo.txt"))],
    });
  });

  it("imports plugin-state legacy plans through doctor", async () => {
    const root = makeDoctorStateDir();
    const sourcePath = path.join(root, "legacy-cache.json");
    const globalSourcePath = path.join(root, "legacy-global-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    fs.writeFileSync(globalSourcePath, "global", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test prompt-context cache",
        sourcePath,
        targetPath: "plugin state:test.prompt-cache",
        pluginId: "telegram",
        namespace: "test.prompt-cache",
        maxEntries: 4,
        scopeKey: "scope",
        cleanupSource: "rename",
        readEntries: () => [
          { key: "old", value: { body: "old" } },
          { key: "existing", value: { body: "stale" } },
          { key: "overflow", value: { body: "overflow" } },
        ],
      },
      {
        kind: "plugin-state-import",
        label: "Test global cache",
        sourcePath: globalSourcePath,
        targetPath: "plugin state:test.global-cache",
        pluginId: "telegram",
        namespace: "test.global-cache",
        maxEntries: 4,
        scopeKey: "",
        cleanupSource: "rename",
        readEntries: () => [{ key: "default", value: { body: "global" }, ttlMs: 60_000 }],
      },
    ];

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.prompt-cache",
        maxEntries: 4,
      });
      await store.register("scope:existing", { body: "fresh" });
      await store.register("other:keep", { body: "other" });
    });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 2 Test prompt-context cache entries → plugin state");
    expect(result.changes).toContain("Migrated 1 Test global cache entry → plugin state");
    expect(result.changes).toContain(
      `Archived Test prompt-context cache legacy source → ${sourcePath}.migrated`,
    );
    expect(result.changes).toContain(
      `Archived Test global cache legacy source → ${globalSourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(globalSourcePath)).toBe(false);
    expect(fs.existsSync(`${globalSourcePath}.migrated`)).toBe(true);

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.prompt-cache",
        maxEntries: 4,
      });
      const valuesByKey = new Map(
        (await store.entries()).map(({ key, value }) => [key, value.body]),
      );
      expect(Object.fromEntries(valuesByKey)).toEqual({
        "other:keep": "other",
        "scope:existing": "fresh",
        "scope:old": "old",
        "scope:overflow": "overflow",
      });

      const globalStore = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.global-cache",
        maxEntries: 4,
      });
      const globalValuesByKey = new Map(
        (await globalStore.entries()).map(({ key, value }) => [key, value.body]),
      );
      expect(Object.fromEntries(globalValuesByKey)).toEqual({
        default: "global",
      });
      const globalEntries = await globalStore.entries();
      expect(globalEntries[0]?.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  it("archives empty plugin-state import sources when the channel plan asks for cleanup", async () => {
    const root = makeDoctorStateDir();
    const sourceDir = path.join(root, "imessage");
    fs.mkdirSync(sourceDir, { recursive: true });
    const sourcePath = path.join(sourceDir, "reply-cache.jsonl");
    fs.writeFileSync(sourcePath, "expired\n", "utf-8");
    if (process.platform !== "win32") {
      fs.chmodSync(sourceDir, 0o755);
      fs.chmodSync(sourcePath, 0o644);
    }
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test expired cache",
        sourcePath,
        targetPath: "plugin state:test.expired-cache",
        pluginId: "telegram",
        namespace: "test.expired-cache",
        maxEntries: 4,
        scopeKey: "",
        cleanupSource: "rename",
        cleanupWhenEmpty: true,
        readEntries: () => [],
      },
    ];

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      `Archived Test expired cache legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(`${sourcePath}.migrated`).mode & 0o777).toBe(0o600);
    }
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

  it("archives fully covered plugin-state imports when the namespace is full", async () => {
    const root = makeDoctorStateDir();
    const sourcePath = path.join(root, "legacy-cache.json");
    fs.writeFileSync(sourcePath, "legacy", "utf-8");
    mockedChannelMigrationPlans.plans = [
      {
        kind: "plugin-state-import",
        label: "Test covered cache",
        sourcePath,
        targetPath: "plugin state:test.covered-cache",
        pluginId: "telegram",
        namespace: "test.covered-cache",
        maxEntries: 1,
        scopeKey: "",
        cleanupSource: "rename",
        readEntries: () => [{ key: "covered", value: { body: "legacy" } }],
      },
    ];

    await withStateDir(root, async () => {
      const store = createPluginStateKeyedStore<{ body: string }>("telegram", {
        namespace: "test.covered-cache",
        maxEntries: 1,
      });
      await store.register("covered", { body: "current" });
    });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      `Archived Test covered cache legacy source → ${sourcePath}.migrated`,
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
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

  it("imports the shipped debug proxy capture sidecar into shared state", async () => {
    const root = makeDoctorStateDir();
    const { sourcePath, blobDir, blobId } = writeLegacyDebugProxyCaptureSidecar(root);
    const certDir = path.join(root, "debug-proxy", "certs");
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, "ca.pem"), "keep");

    const detected = await detectLegacyStateMigrations({
      cfg: {},
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(detected.debugProxyCaptureSidecar).toEqual({
      sourcePath,
      blobDir,
      hasLegacy: true,
    });
    expect(detected.preview).toContain(
      `- Debug proxy capture sidecar: ${sourcePath} → shared SQLite state`,
    );

    const result = await runLegacyStateMigrations({ detected });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain(
      "Migrated 1 debug proxy capture session, 1 event, and 1 blob → shared SQLite state",
    );
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(blobDir)).toBe(false);
    expect(fs.existsSync(`${blobDir}.migrated`)).toBe(true);
    expect(fs.readFileSync(path.join(certDir, "ca.pem"), "utf8")).toBe("keep");

    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      state.db.prepare("SELECT id, mode FROM capture_sessions WHERE id = ?").get("legacy-session"),
    ).toEqual({ id: "legacy-session", mode: "proxy-run" });
    expect(
      state.db
        .prepare("SELECT flow_id, data_blob_id FROM capture_events WHERE session_id = ?")
        .get("legacy-session"),
    ).toEqual({ flow_id: "legacy-flow", data_blob_id: blobId });
    const blob = state.db
      .prepare("SELECT data FROM capture_blobs WHERE blob_id = ?")
      .get(blobId) as { data?: Uint8Array } | undefined;
    expect(gunzipSync(Buffer.from(blob?.data ?? [])).toString("utf8")).toBe('{"legacy":true}');
  });

  it("uses stored per-session debug proxy blob directories without active overrides", async () => {
    const root = makeDoctorStateDir();
    const blobDir = path.join(root, "custom-session-blobs");
    const { sourcePath, blobId } = writeLegacyDebugProxyCaptureSidecar(root, { blobDir });
    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([
      `Left migrated debug proxy capture blobs in stored session directory: ${blobDir}`,
    ]);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    expect(fs.existsSync(blobDir)).toBe(true);
    const state = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
    });
    expect(
      state.db.prepare("SELECT blob_id FROM capture_blobs WHERE blob_id = ?").get(blobId),
    ).toEqual({ blob_id: blobId });
    expect(state.db.prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
      count: 1,
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

  it("leaves debug proxy sources in place when a session id conflicts", async () => {
    const root = makeDoctorStateDir();
    const { sourcePath, blobDir } = writeLegacyDebugProxyCaptureSidecar(root);
    const state = () => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } }).db;
    state()
      .prepare(
        `INSERT INTO capture_sessions (
          id, started_at, mode, source_scope, source_process
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-session", 999, "different", "openclaw", "openclaw");

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([
      `Failed migrating debug proxy capture sidecar ${sourcePath}: session legacy-session already exists with different data`,
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(blobDir)).toBe(true);
    expect(state().prepare("SELECT COUNT(*) AS count FROM capture_events").get()).toEqual({
      count: 0,
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

  it.each(["embedded", "record-only"] as const)(
    "imports a legacy %s plugin install index into shared state",
    async (shape) => {
      const root = makeDoctorStateDir();
      const sourcePath = path.join(root, "plugins", "installs.json");
      const record = { source: "npm", spec: "demo@1.0.0" };
      writeJson5(
        sourcePath,
        shape === "embedded"
          ? { plugins: [{ pluginId: "demo", installRecord: record }] }
          : { installRecords: { demo: record } },
      );
      const detected = await detectLegacyStateMigrations({
        cfg: {},
        env: { OPENCLAW_STATE_DIR: root },
      });
      expect(detected.pluginInstallIndex).toEqual({ sourcePath, hasLegacy: true });
      expect(detected.preview).toContain(
        `- Plugin install index: ${sourcePath} → shared SQLite state`,
      );

      const result = await runLegacyStateMigrations({ detected });

      expect(result.warnings).toStrictEqual([]);
      expect(result.changes).toContain(
        "Migrated plugin install index 1 record → shared SQLite state",
      );
      expect(result.changes).toContain(
        `Archived plugin install index legacy source → ${sourcePath}.migrated`,
      );
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
      await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
        installRecords: { demo: { source: "npm", spec: "demo@1.0.0" } },
        plugins: [],
      });
    },
  );

  it("merges missing legacy plugin install records into an existing SQLite index", async () => {
    const root = makeDoctorStateDir();
    await writeExistingPluginInstallIndex(root, {
      existing: {
        source: "npm",
        spec: "existing@1.0.0",
      },
    });
    const sourcePath = writeLegacyPluginInstallIndex(root, {
      legacy: {
        source: "git",
        spec: "git:file:///tmp/legacy",
      },
    });

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Merged 1 legacy plugin install record → shared SQLite state");
    expect(fs.existsSync(sourcePath)).toBe(false);
    await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
      installRecords: {
        existing: { source: "npm", spec: "existing@1.0.0" },
        legacy: { source: "git", spec: "git:file:///tmp/legacy" },
      },
    });
  });

  it("archives exact legacy npm install record when SQLite has authoritative resolved metadata", async () => {
    const root = makeDoctorStateDir();
    await writeExistingPluginInstallIndex(root, {
      discord: {
        source: "npm",
        spec: "@openclaw/discord@latest",
        resolvedName: "@openclaw/discord",
        resolvedVersion: "2026.6.16",
        integrity: "sha512-current",
        installedAt: "2026-06-16T12:00:00.000Z",
      },
    });
    const sourcePath = writeLegacyPluginInstallIndex(root, {
      discord: {
        source: "npm",
        spec: "@openclaw/discord@2026.6.16",
        version: "2026.6.16",
        installedAt: "2026-06-01T12:00:00.000Z",
      },
    });

    const result = await runLegacyStateMigrationsForRoot(root);

    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
    await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
      installRecords: {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@latest",
          resolvedName: "@openclaw/discord",
          resolvedVersion: "2026.6.16",
          integrity: "sha512-current",
        },
      },
    });
  });

  it.each([false, true])(
    "archives conflicting plugin metadata before config repair (refusal: %s)",
    async (refuseConfig) => {
      const root = makeDoctorStateDir();
      await writeExistingPluginInstallIndex(root, {
        demo: {
          source: "npm",
          spec: "demo@latest",
          version: "1.0.0",
        },
      });
      const sourcePath = writeLegacyPluginInstallIndex(root, {
        demo: {
          source: "npm",
          spec: "demo@1.0.0",
          version: "1.0.0",
        },
      });

      const result = await autoMigrateLegacyState({
        cfg: refuseConfig
          ? Object.defineProperty({}, "meta", {
              get() {
                throw new Error("config repair refused");
              },
            })
          : {},
        env: { ...process.env, OPENCLAW_STATE_DIR: root },
        doctorOnlyStateMigrations: true,
      });

      expect(result.warnings).toStrictEqual(refuseConfig ? ["config repair refused"] : []);
      expect(result.notices).toStrictEqual([
        "Kept canonical shared SQLite plugin install metadata despite differing legacy records for: demo",
      ]);
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);

      const retry = await runLegacyStateMigrationsForRoot(root);
      expect(retry.warnings).toStrictEqual([]);
      expect(retry.notices).toBeUndefined();
      await expect(readPersistedInstalledPluginIndex({ stateDir: root })).resolves.toMatchObject({
        installRecords: {
          demo: { source: "npm", spec: "demo@latest", version: "1.0.0" },
        },
      });
    },
  );

  it("keeps plugin install archive failures blocking after choosing SQLite metadata", async () => {
    const root = makeDoctorStateDir();
    await writeExistingPluginInstallIndex(root, {
      demo: {
        source: "npm",
        spec: "demo@latest",
        version: "1.0.0",
      },
    });
    const sourcePath = writeLegacyPluginInstallIndex(root, {
      demo: {
        source: "npm",
        spec: "demo@1.0.0",
        version: "1.0.0",
      },
    });
    const rename = failRenameOnce(sourcePath);

    const result = await autoMigrateLegacyState({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      doctorOnlyStateMigrations: true,
    });
    rename.mockRestore();

    expect(result.warnings).toStrictEqual([
      `Failed archiving plugin install index ${sourcePath}: Error: forced archive failure`,
    ]);
    expect(result.notices).toStrictEqual([
      "Kept canonical shared SQLite plugin install metadata despite differing legacy records for: demo",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(true);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);

    const retry = await runLegacyStateMigrationsForRoot(root);
    expect(retry.warnings).toStrictEqual([]);
    expect(retry.notices).toStrictEqual([
      "Kept canonical shared SQLite plugin install metadata despite differing legacy records for: demo",
    ]);
    expect(fs.existsSync(sourcePath)).toBe(false);
    expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
  });

  it("reports completed transcript migration when a custom agent owns session state", async () => {
    const root = makeDoctorStateDir();
    const sessionId = "custom-agent-review";
    const sourceDir = path.join(root, "transcripts", "2026-07-01", sessionId);
    fs.mkdirSync(sourceDir, { recursive: true });
    writeJson5(path.join(sourceDir, "metadata.json"), {
      sessionId,
      title: "Design review",
      source: {
        providerId: "manual-transcript",
        meetingUrl: "https://meet.example.invalid/room",
      },
      startedAt: "2026-07-01T10:00:00.000Z",
      stoppedAt: "2026-07-01T10:30:00.000Z",
    });
    const utterances = [
      { id: "u-1", sessionId, speaker: { label: "Alex" }, text: "First line", final: true },
      { id: "u-2", sessionId, speaker: { label: "Sam" }, text: "Second line", final: true },
    ];
    fs.writeFileSync(
      path.join(sourceDir, "transcript.jsonl"),
      `${utterances.map((utterance) => JSON.stringify(utterance)).join("\n")}\n`,
    );
    writeJson5(path.join(sourceDir, "summary.json"), {
      sessionId,
      title: "Design review",
      generatedAt: "2026-07-01T10:31:00.000Z",
      overview: "First line. Second line.",
      transcript: ["Alex: First line", "Sam: Second line"],
      decisions: [],
      actionItems: [],
      risks: [],
      utteranceCount: 2,
    });
    fs.writeFileSync(path.join(sourceDir, "summary.md"), "# Design review\n\nFirst line.\n");
    const env = {
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_AGENT_DIR: path.join(root, "custom-agent"),
    } as NodeJS.ProcessEnv;

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env,
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => Date.parse("2026-07-02T00:00:00.000Z"),
    });

    expect(result).toMatchObject({ migrated: true, skipped: true, warnings: [] });
    expect(result.changes.join("\n")).not.toMatch(/meeting transcript|utterance/i);
    expect(fs.existsSync(sourceDir)).toBe(false);
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT COUNT(*) AS count FROM meeting_transcript_sessions")
        .get(),
    ).toEqual({ count: 1 });
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

  it("classifies already-migrated symlink mirrors without warnings", async () => {
    const flatRoot = makeDoctorStateDir();
    const flat = ensureLegacyAndTargetStateDirs(flatRoot);
    fs.mkdirSync(path.join(flat.targetDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(flat.targetDir, "agent"), { recursive: true });
    fs.symlinkSync(
      path.join(flat.targetDir, "sessions"),
      path.join(flat.legacyDir, "sessions"),
      DIR_LINK_TYPE,
    );
    fs.symlinkSync(
      path.join(flat.targetDir, "agent"),
      path.join(flat.legacyDir, "agent"),
      DIR_LINK_TYPE,
    );
    expectUnmigratedWithoutWarnings(await runFreshStateDirMigration(flatRoot));

    const nestedRoot = makeDoctorStateDir();
    const nested = ensureLegacyAndTargetStateDirs(nestedRoot);
    fs.mkdirSync(path.join(nested.targetDir, "agents", "main"), { recursive: true });
    fs.mkdirSync(path.join(nested.legacyDir, "agents"), { recursive: true });
    fs.symlinkSync(
      path.join(nested.targetDir, "agents", "main"),
      path.join(nested.legacyDir, "agents", "main"),
      DIR_LINK_TYPE,
    );
    expectUnmigratedWithoutWarnings(await runFreshStateDirMigration(nestedRoot));
  });

  it("warns when target exists and legacy state is not a safe mirror", async () => {
    const fileRoot = makeDoctorStateDir();
    const file = ensureLegacyAndTargetStateDirs(fileRoot);
    fs.writeFileSync(path.join(file.legacyDir, "sessions.json"), "{}", "utf-8");
    expectTargetAlreadyExistsWarning(await runFreshStateDirMigration(fileRoot), file.targetDir);

    const outsideRoot = makeDoctorStateDir();
    const outside = ensureLegacyAndTargetStateDirs(outsideRoot);
    const outsideDir = path.join(outsideRoot, ".outside-state");
    fs.mkdirSync(path.join(outside.targetDir, "sessions"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(outside.legacyDir, "sessions"), DIR_LINK_TYPE);
    expectTargetAlreadyExistsWarning(
      await runFreshStateDirMigration(outsideRoot),
      outside.targetDir,
    );

    const brokenRoot = makeDoctorStateDir();
    const broken = ensureLegacyAndTargetStateDirs(brokenRoot);
    const targetSessionDir = path.join(broken.targetDir, "sessions");
    fs.mkdirSync(targetSessionDir, { recursive: true });
    fs.symlinkSync(targetSessionDir, path.join(broken.legacyDir, "sessions"), DIR_LINK_TYPE);
    fs.rmSync(targetSessionDir, { recursive: true, force: true });
    expectTargetAlreadyExistsWarning(await runFreshStateDirMigration(brokenRoot), broken.targetDir);

    const secondHopRoot = makeDoctorStateDir();
    const secondHop = ensureLegacyAndTargetStateDirs(secondHopRoot);
    const secondHopOutsideDir = path.join(secondHopRoot, ".outside-state");
    fs.mkdirSync(secondHopOutsideDir, { recursive: true });
    const targetHop = path.join(secondHop.targetDir, "hop");
    fs.symlinkSync(secondHopOutsideDir, targetHop, DIR_LINK_TYPE);
    fs.symlinkSync(targetHop, path.join(secondHop.legacyDir, "sessions"), DIR_LINK_TYPE);
    expectTargetAlreadyExistsWarning(
      await runFreshStateDirMigration(secondHopRoot),
      secondHop.targetDir,
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
