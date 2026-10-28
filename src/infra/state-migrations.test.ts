// Covers legacy state migration detection and repair behavior.
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  importStateMigrationFixtureGraph,
  rerunStateMigrationFixtureAfterRestart,
} from "./state-migrations.native-graph.test-support.js";
let native = await importStateMigrationFixtureGraph();
import type { OpenClawConfig } from "../config/config.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-module.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import type { EngineConnection } from "./sql-connection.js";

type DetectLegacyStateParams = Parameters<typeof native.detectLegacyStateMigrationsWithSurfaces>[0];
type RunLegacyStateParams = Parameters<typeof native.runLegacyStateMigrationsWithSurfaces>[0];
type AutoMigrateLegacyStateParams = Parameters<typeof native.autoMigrateLegacyStateWithSurfaces>[0];

type CoreMigrationParams<T> = Omit<T, "legacySessionSurfaces"> & {
  legacySessionSurfaces?: DetectLegacyStateParams["legacySessionSurfaces"];
};

// This broad core suite intentionally exercises migration mechanics without plugin-owned keys.
// Package-shaped coverage owns configured plugin resolution and setup-sidecar loading.
function detectLegacyStateMigrations(params: CoreMigrationParams<DetectLegacyStateParams>) {
  return native.detectLegacyStateMigrationsWithSurfaces({
    legacySessionSurfaces: native.EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

function runLegacyStateMigrations(params: CoreMigrationParams<RunLegacyStateParams>) {
  return native.runLegacyStateMigrationsWithSurfaces({
    legacySessionSurfaces: native.EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

function autoMigrateLegacyState(params: CoreMigrationParams<AutoMigrateLegacyStateParams>) {
  return native.autoMigrateLegacyStateWithSurfaces({
    legacySessionSurfaces: native.EMPTY_LEGACY_SESSION_SURFACES,
    ...params,
  });
}

// Static helpers can retain earlier cohorts after resetModules; close every cohort at teardown.
const migrationDatabaseClosers = new Set<() => void | Promise<void>>([
  native.closeOpenClawAgentDatabasesAsync,
  native.closeOpenClawAgentDatabasesForTest,
  native.closeStateDatabaseForTest,
]);

async function reloadStateDirFixtureGraph() {
  await native.closeDatabaseTestCohorts(migrationDatabaseClosers);
  vi.resetModules();
  native = await importStateMigrationFixtureGraph();
  migrationDatabaseClosers.add(native.closeOpenClawAgentDatabasesAsync);
  migrationDatabaseClosers.add(native.closeOpenClawAgentDatabasesForTest);
  migrationDatabaseClosers.add(native.closeStateDatabaseForTest);
}

async function rerunAutomaticMigrationAfterRestart(params: AutoMigrateLegacyStateParams) {
  return await rerunStateMigrationFixtureAfterRestart(params, native, migrationDatabaseClosers);
}

const pluginDoctorStateMigrationEntries = vi.hoisted(
  (): {
    entries: Array<{
      pluginId: string;
      channelIds?: string[];
      trustedForDurableStores?: boolean;
      migration: PluginDoctorStateMigration;
    }>;
  } => ({ entries: [] }),
);

const legacyChannelStateMigrationEntries = vi.hoisted(() => ({
  entries: [] as Array<{ pluginId: string; migration: PluginDoctorStateMigration }>,
}));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  const buildStateMigrationInventory = (params?: { config?: OpenClawConfig }) => ({
    knownPluginIds: actual.collectRelevantDoctorPluginIds(params?.config ?? {}),
    sessionStoreOwnerPluginIds: [],
    descriptors: [
      ...pluginDoctorStateMigrationEntries.entries,
      ...legacyChannelStateMigrationEntries.entries,
    ].map((entry) =>
      Object.assign(
        { pluginId: entry.pluginId, id: entry.migration.id },
        entry.migration.doctorOnly === true ? { doctorOnly: true as const } : {},
        entry.migration.phase ? { phase: entry.migration.phase } : {},
      ),
    ),
    unresolvedPluginIds: [],
  });
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: vi.fn(() => [
      ...pluginDoctorStateMigrationEntries.entries,
      ...legacyChannelStateMigrationEntries.entries,
    ]),
    resolveLivePluginDoctorStateMigrationInventory: vi.fn(buildStateMigrationInventory),
    resolvePluginDoctorStateMigrationInventory: vi.fn(buildStateMigrationInventory),
  };
});

const tempDirs = createTrackedTempDirs();
const APNS_DEVICE_FIELD = "token";

type ConfigHealthDatabase = Pick<OpenClawStateKyselyDatabase, "config_health_entries">;

legacyChannelStateMigrationEntries.entries = [
  {
    pluginId: "mobileauth",
    migration: native.definePluginDoctorMigrationFromPlans({
      id: "mobileauth-legacy-state",
      label: "MobileAuth legacy state",
      resolvePlans: ({ oauthDir }) => {
        let entries: fsSync.Dirent[];
        try {
          entries = fsSync
            .readdirSync(oauthDir, { withFileTypes: true })
            .toSorted((left, right) => left.name.localeCompare(right.name));
        } catch {
          return [];
        }
        return entries.flatMap((entry) => {
          if (!entry.isFile() || !/^(creds|pre-key-1)\.json$/u.test(entry.name)) {
            return [];
          }
          const targetPath = path.join(oauthDir, "mobileauth", "default", entry.name);
          if (fsSync.existsSync(targetPath)) {
            return [];
          }
          return {
            kind: "move" as const,
            label: `MobileAuth auth ${entry.name}`,
            sourcePath: path.join(oauthDir, entry.name),
            targetPath,
          };
        });
      },
    }),
  },
];

const createTempDir = () => tempDirs.make("openclaw-state-migrations-test-");

async function createDefaultMigrationFixture() {
  return {
    ...native.createMigrationContext(await createTempDir()),
    cfg: native.createConfig(),
  };
}

async function writeJsonFixture(filePath: string, value: unknown) {
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

function readConfigHealthRows(env: NodeJS.ProcessEnv): Array<{
  config_path: string;
  last_known_good_json: string | null;
  last_promoted_good_json: string | null;
  last_observed_suspicious_signature: string | null;
}> {
  const { db } = native.openOpenClawStateDatabase({ env });
  const stateDb = native.getNodeSqliteKysely<ConfigHealthDatabase>(db);
  return native.executeSqliteQuerySync(
    db,
    stateDb
      .selectFrom("config_health_entries")
      .select([
        "config_path",
        "last_known_good_json",
        "last_promoted_good_json",
        "last_observed_suspicious_signature",
      ])
      .orderBy("config_path", "asc"),
  ).rows;
}

function insertConfigHealthRow(
  env: NodeJS.ProcessEnv,
  row: {
    config_path: string;
    last_known_good_json: string | null;
    last_promoted_good_json: string | null;
    last_observed_suspicious_signature: string | null;
  },
): void {
  const { db } = native.openOpenClawStateDatabase({ env });
  const stateDb = native.getNodeSqliteKysely<ConfigHealthDatabase>(db);
  native.executeSqliteQuerySync(
    db,
    stateDb.insertInto("config_health_entries").values({
      ...row,
      updated_at_ms: Date.now(),
    }),
  );
}

function seedSchemaOnlyLegacyAgentDatabase(
  stateDir: string,
  options: { agentId?: string | null } = {},
): string {
  const databasePath = path.join(stateDir, "agent", "openclaw-agent.sqlite");
  fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    native.ensureOpenClawAgentDatabaseSchema(database, {
      agentId: "openclaw",
      env: native.createEnv(stateDir),
      path: databasePath,
      register: false,
    });
    if (options.agentId !== undefined) {
      database
        .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'")
        .run(options.agentId);
    }
  } finally {
    database.close();
  }
  return databasePath;
}

async function createLegacyStateFixture(params?: { includePreKey?: boolean }) {
  const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();

  await fs.mkdir(path.join(stateDir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "agents", "worker-1", "sessions"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "agent"), { recursive: true });
  await fs.mkdir(path.join(stateDir, "credentials"), { recursive: true });

  await fs.writeFile(
    path.join(stateDir, "sessions", "sessions.json"),
    `${JSON.stringify({ legacyDirect: { sessionId: "legacy-direct", updatedAt: 10 } }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(stateDir, "sessions", "trace.jsonl"), "{}\n", "utf8");
  await fs.writeFile(
    path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
    `${JSON.stringify(
      {
        "group:mobile-room": { sessionId: "group-session", updatedAt: 5 },
        "group:legacy-room": { sessionId: "generic-group-session", updatedAt: 4 },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(stateDir, "agent", "settings.json"), '{"ok":true}\n', "utf8");
  await fs.writeFile(path.join(stateDir, "credentials", "creds.json"), '{"auth":true}\n', "utf8");
  if (params?.includePreKey) {
    await fs.writeFile(
      path.join(stateDir, "credentials", "pre-key-1.json"),
      '{"preKey":true}\n',
      "utf8",
    );
  }
  await fs.writeFile(path.join(stateDir, "credentials", "oauth.json"), '{"oauth":true}\n', "utf8");
  await fs.writeFile(
    path.join(stateDir, "credentials", "chatapp-allowFrom.json"),
    '["123","456"]\n',
    "utf8",
  );

  return {
    root,
    stateDir,
    env,
    cfg,
  };
}

function createWorktreeInserter(db: EngineConnection, root: string, stateDir: string) {
  const insert = db.prepare(
    `INSERT INTO worktrees (
      id, repo_fingerprint, repo_root, path, branch, base_ref, owner_kind,
      created_at, last_active_at, provisioned_paths_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return (id: string, timestamp: number, provisionedPaths: string | null = null) => {
    insert.run(
      id,
      `${id}-fingerprint`,
      path.join(root, `repo-${id}`),
      path.join(stateDir, "worktrees", id),
      `openclaw/${id}`,
      "HEAD",
      "session",
      timestamp,
      timestamp,
      provisionedPaths,
    );
  };
}

afterEach(async () => {
  vi.useRealTimers();
  pluginDoctorStateMigrationEntries.entries = [];
  await native.closeDatabaseTestCohorts(migrationDatabaseClosers);
  native.resetPluginRuntimeStateForTest();
});

afterAll(async () => {
  await tempDirs.cleanup();
});

describe("state migrations", () => {
  it("migrates workspace setup during Doctor preflight before runtime consumers", async () => {
    const { root, env } = native.createMigrationContext(await createTempDir());
    const workspaceDir = path.join(root, "workspace");
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: workspaceDir } } },
    };
    const sourcePath = path.join(workspaceDir, "openclaw-workspace-state.json");
    const completedAt = "2026-07-15T10:01:00.000Z";
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await writeJsonFixture(sourcePath, { version: 1, setupCompletedAt: completedAt });
    const assertReady = () =>
      native.assertWorkspaceStateMigrationReady({
        workspaceDirs: [workspaceDir],
        env,
      });

    await autoMigrateLegacyState({ cfg, env, homedir: () => root });
    expect(assertReady).toThrow("Legacy workspace setup state requires migration");

    const repaired = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect(repaired.warnings).toEqual([]);
    expect(assertReady).not.toThrow();
    expect(fsSync.existsSync(sourcePath)).toBe(false);
    expect(
      (await native.readWorkspaceStateSnapshot(workspaceDir, { env })).setup.setupCompletedAt,
    ).toBe(completedAt);
  });

  it("does not treat wildcard route bindings as pairing account ids", async () => {
    const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
    cfg.bindings = [
      {
        agentId: "worker-1",
        match: { channel: "chatapp", accountId: "*" },
      },
    ];
    const credentialsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, "chatapp-allowFrom.json"),
      '["default-user"]\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(credentialsDir, "chatapp-alpha-allowFrom.json"),
      '["scoped-user"]\n',
      "utf8",
    );

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });

    expect(result.warnings).toEqual([]);
    expect(native.readChannelPairingStateSnapshot("chatapp", env).allowFrom).toEqual({
      alpha: ["default-user", "scoped-user"],
    });
    await native.expectMissingPath(path.join(credentialsDir, "chatapp-allowFrom.json"));
    await native.expectMissingPath(path.join(credentialsDir, "chatapp-alpha-allowFrom.json"));
  });

  it("uses the retained migration owner for channel pairing account selection", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const cfg = native.retainLegacyDefaultAgentId(
      {
        agents: {
          ownership: "explicit",
          defaults: { pdfMaxPages: 42 },
          entries: { main: { name: "Main" }, ops: { name: "Ops" } },
        },
        channels: { chatapp: {} },
      } satisfies OpenClawConfig,
      "main",
    );
    const credentialsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, "chatapp-allowFrom.json"),
      '["123456789"]\n',
      "utf8",
    );
    const plugin = native.createChannelTestPluginBase({
      id: "chatapp",
      config: {
        defaultAccountId: (config) => {
          const ownerAgentId = native.resolveDefaultAgentId(config);
          const owner = config.agents?.entries?.[ownerAgentId];
          return owner?.name === "Main" && config.agents?.defaults?.pdfMaxPages === 42
            ? "default"
            : "lost-owner-config";
        },
      },
    });
    native.setActivePluginRegistry(
      native.createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
    );

    const authoredConfig = structuredClone(cfg);
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    expect(cfg).toEqual(authoredConfig);
    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toEqual([]);
    expect(native.readChannelPairingStateSnapshot("chatapp", env).allowFrom).toEqual({
      default: ["123456789"],
    });
  });

  it.each([
    { bound: "Bound.Acct", explicit: "alpha", expected: "bound.acct", entries: ["unscoped"] },
    { bound: undefined, explicit: "alpha", expected: "alpha", entries: ["unscoped", "scoped"] },
    { bound: undefined, explicit: undefined, expected: "plugin.default", entries: ["unscoped"] },
  ])("preserves loaded plugin accounts with $expected as the default", async (selection) => {
    const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
    cfg.channels = {
      chatapp: { accounts: { beta: {}, alpha: {} }, defaultAccount: selection.explicit },
    };
    if (selection.bound) {
      cfg.bindings = [
        { agentId: "worker-1", match: { channel: "chatapp", accountId: selection.bound } },
      ];
    }
    const plugin = native.createChannelTestPluginBase({
      id: "chatapp",
      config: {
        listAccountIds: (config) => {
          expect(config).toBe(cfg);
          return ["Plugin.Acct"];
        },
        defaultAccountId: () => "Plugin.Default",
      },
    });
    native.setActivePluginRegistry(
      native.createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
    );
    const sourceDir = path.join(stateDir, "credentials");
    await fs.mkdir(sourceDir, { recursive: true });
    for (const suffix of ["", "-plugin.acct", "-alpha", "-beta"]) {
      await fs.writeFile(
        path.join(sourceDir, `chatapp${suffix}-allowFrom.json`),
        suffix ? '["scoped"]' : '["unscoped"]',
      );
    }
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    // Import uses captured detection facts even if the caller replaces its config later.
    const result = await runLegacyStateMigrations({ detected, config: {}, env });

    expect(result.warnings).toEqual([]);
    expect(native.readChannelPairingStateSnapshot("chatapp", env).allowFrom).toEqual({
      "plugin.acct": ["scoped"],
      alpha: ["scoped"],
      beta: ["scoped"],
      [selection.expected]: selection.entries,
    });
    expect(await fs.readdir(sourceDir)).toEqual([]);
  });

  it("preserves ambiguous pairing ownership when only the session fallback exists", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
      channels: { chatapp: {} },
    };
    const credentialsDir = path.join(stateDir, "credentials");
    await fs.mkdir(credentialsDir, { recursive: true });
    await fs.writeFile(
      path.join(credentialsDir, "chatapp-allowFrom.json"),
      '["123456789"]\n',
      "utf8",
    );
    const plugin = native.createChannelTestPluginBase({
      id: "chatapp",
      config: { defaultAccountId: (config) => native.resolveDefaultAgentId(config) },
    });
    native.setActivePluginRegistry(
      native.createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]),
    );

    await expect(
      detectLegacyStateMigrations({ cfg, env, homedir: () => root }),
    ).rejects.toBeInstanceOf(native.AgentSelectionRequiredError);
  });

  it.each(["absent", "present"] as const)(
    "keeps automatic migration read-only with retired Workshop proposals %s",
    async (proposals) => {
      const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
      cfg.agents = { entries: { main: {} } };
      const databasePath = native.openOpenClawStateDatabase({ env }).path;
      await native.closeStateDatabaseForTest();
      expect(await native.migrateDaemonRuntimePins(env)).toEqual({
        changes: [],
        warnings: [],
      });
      const draft = path.join(
        stateDir,
        "skill-workshop",
        "proposals",
        "retained-procedure-1234",
        "PROPOSAL.md",
      );
      const writer = new DatabaseSync(databasePath);
      if (proposals === "present") {
        writer.exec(`
        CREATE TABLE skill_workshop_proposals (
          proposal_id TEXT NOT NULL PRIMARY KEY,
          record_json TEXT NOT NULL,
          owner_agent_id TEXT,
          status TEXT NOT NULL
        ) STRICT;
        INSERT INTO skill_workshop_proposals
          VALUES ('retained-procedure-1234', '{}', 'main', 'pending');
      `);
        await fs.mkdir(path.dirname(draft), { recursive: true });
        await fs.writeFile(draft, "# Retained procedure\n");
      }
      writer.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
      try {
        const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });
        expect(result).toMatchObject({ changes: [], warnings: [] });
        const ids = result.stepReceipts.map((receipt) => receipt.id);
        expect(ids).not.toContain("skill-workshop");
        if (proposals === "present") {
          await expect(fs.readFile(draft, "utf8")).resolves.toBe("# Retained procedure\n");
        }
      } finally {
        writer.exec("ROLLBACK;");
        writer.close();
      }
    },
  );

  it.each(["automatic", "doctor", "doctor-refusal"] as const)(
    "records Workshop work after mutation and respects the prior refusal in %s mode",
    async (mode) => {
      const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      const databasePath = native.openOpenClawStateDatabase({ env }).path;
      native.closeOpenClawStateDatabaseForTest();
      const workshopRoot = path.join(stateDir, "skill-workshop");
      const proposalsDir = path.join(workshopRoot, "proposals");
      const recordPath = path.join(proposalsDir, "rejected-procedure-1234", "proposal.json");
      await fs.mkdir(path.dirname(recordPath), { recursive: true });
      await fs.writeFile(recordPath, '{"status":"rejected"}\n');
      if (mode === "doctor-refusal") {
        await fs.mkdir(path.join(stateDir, "tui"), { recursive: true });
        await fs.writeFile(path.join(stateDir, "tui", "last-session.json"), "{broken");
      }
      const callbackSamples: boolean[] = [];
      const result = await autoMigrateLegacyState({
        cfg,
        env,
        homedir: () => root,
        doctorOnlyStateMigrations: mode !== "automatic",
        onStepReceipt: (receipt) => {
          if (receipt.id === "skill-workshop") {
            callbackSamples.push(fsSync.existsSync(proposalsDir));
          }
        },
      });
      const workshop = result.stepReceipts.find((receipt) => receipt.id === "skill-workshop");
      if (mode === "automatic") {
        expect(result.warnings).toEqual([]);
        expect(workshop).toBeUndefined();
        expect(callbackSamples).toEqual([]);
        await expect(fs.readFile(recordPath, "utf8")).resolves.toBe('{"status":"rejected"}\n');
        return;
      }
      expect(workshop).toMatchObject({
        phase: "final",
        source: [
          { kind: "sqlite", path: databasePath },
          { kind: "path", path: workshopRoot },
          { kind: "owner", id: "core:skill-workshop" },
        ],
        target: [
          { kind: "sqlite", path: databasePath },
          { kind: "owner", id: "core:skill-workshop" },
        ],
        requiredness: "conditional",
        reversibility: "checkpoint-required",
      });
      if (mode === "doctor-refusal") {
        expect(workshop).toMatchObject({
          outcome: "refused",
          refusal: { code: "blocked-by-prior-refusal" },
          changes: [],
        });
        expect(callbackSamples).toEqual([true]);
        await expect(fs.readFile(recordPath, "utf8")).resolves.toBe('{"status":"rejected"}\n');
      } else {
        expect(result.warnings).toEqual([]);
        expect(workshop).toMatchObject({
          outcome: "completed",
          changes: [`Removed retired Skill Workshop proposal files from ${proposalsDir}.`],
        });
        expect(callbackSamples).toEqual([false]);
        await expect(fs.access(proposalsDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it.each([
    { location: "inside", doctorOnlyStateMigrations: false },
    { location: "outside", doctorOnlyStateMigrations: false },
    { location: "inside", doctorOnlyStateMigrations: true },
    { location: "outside", doctorOnlyStateMigrations: true },
  ])(
    "preserves the retired physical owner of a shared store $location state (Doctor: $doctorOnlyStateMigrations)",
    async ({ location, doctorOnlyStateMigrations }) => {
      const root = fsSync.realpathSync.native(await createTempDir());
      const stateDir = path.join(root, ".openclaw");
      const env = native.createEnv(stateDir);
      const storePath = path.join(location === "inside" ? stateDir : root, "shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { qa: {} } },
        session: { store: storePath },
      };
      const scope = {
        agentId: "qa",
        defaultAgentId: "main",
        env,
        sessionKey: "agent:qa:proof",
        storePath,
      };
      await native.upsertSessionEntryCore(scope, {
        sessionId: "qa-source",
        updatedAt: 1000,
      });
      await native.drainSessionMigrationFixture(root);
      const originalEntry = native.loadSessionEntryReadOnly(scope);
      expect(originalEntry).toMatchObject({
        sessionId: "qa-source",
        updatedAt: expect.any(Number),
      });

      const readFile = vi.spyOn(fsSync, "readFileSync");
      try {
        const result = await autoMigrateLegacyState({
          cfg,
          env,
          homedir: () => root,
          doctorOnlyStateMigrations,
        });
        expect(result.warnings).toEqual([]);
        expect(readFile.mock.calls.map(([pathname]) => pathname)).not.toContain(storePath);
      } finally {
        readFile.mockRestore();
      }
      await native.drainSessionMigrationFixture(root);
      expect(native.listOpenClawRegisteredAgentDatabases({ env })).toEqual([
        expect.objectContaining({ agentId: "main", path: storePath }),
      ]);
      expect(native.loadSessionEntryReadOnly(scope)).toStrictEqual(originalEntry);
      const database = new DatabaseSync(storePath, { readOnly: true });
      try {
        expect(
          database
            .prepare("SELECT agent_id, app_version FROM schema_meta WHERE meta_key = ?")
            .get("historical-transcript-directives-v1"),
        ).toEqual(
          doctorOnlyStateMigrations
            ? { agent_id: "main", app_version: JSON.stringify({ phase: "complete", version: 2 }) }
            : undefined,
        );
        expect(
          database.prepare("SELECT session_key FROM session_nodes ORDER BY session_key").all(),
        ).toEqual([{ session_key: "agent:qa:proof" }]);
      } finally {
        database.close();
      }
    },
  );

  it("reports unresolved legacy-main ownership as a nonblocking automatic notice", async () => {
    const { root, env } = native.createMigrationContext(await createTempDir());
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    };
    native.runOpenClawAgentWriteTransaction(
      (database) =>
        native.writeSessionEntry(
          database,
          "agent:main:chat",
          { sessionId: "legacy-main-session", updatedAt: 100 },
          { allowStoredAliases: true, previousEntry: null },
        ),
      { agentId: "main", env },
    );

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.warnings).toEqual([]);
    expect(result.notices).toEqual([
      expect.stringContaining("legacy main rows have no unambiguous configured owner"),
    ]);
  });

  it("preserves retired config locators before an advisory transcript migration return", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    native.openOpenClawStateDatabase({ env });
    const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
    {
      using database = new DatabaseSync(databasePath);
      native.ensureOpenClawAgentDatabaseSchema(database, {
        agentId: "main",
        env,
        path: databasePath,
        register: false,
      });
      database
        .prepare(
          "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,app_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run("historical-transcript-directives-v1", "agent", 1, "main", "invalid-json", 1, 1);
    }
    const store = path.join(root, "legacy-jobs.json");
    const cfg: OpenClawConfig & { cron: { store: string } } = {
      agents: { ownership: "explicit", entries: { main: {} } },
      cron: { store },
    };
    const result = await autoMigrateLegacyState({ cfg, env, invocationPurpose: "doctor" });
    expect(result.warnings).toContainEqual(
      expect.stringContaining("invalid historical transcript migration cursor"),
    );
    expect(native.readConfigMachineState("cron.store", { env })).toBe(store);
    expect(result.changes).toContain("Migrated cron.store → shared SQLite state");
  });

  it("ignores a schema-only legacy agent database without selecting an owner", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, blocker: {}, digest: {} } },
    };
    const databasePath = seedSchemaOnlyLegacyAgentDatabase(stateDir);

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.warnings).toEqual([]);
    expect(result.notices ?? []).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(fsSync.existsSync(databasePath)).toBe(true);
    expect(fsSync.existsSync(path.join(stateDir, "agents", "main", "agent"))).toBe(false);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: native.OPENCLAW_AGENT_SCHEMA_VERSION,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()).toEqual({
        count: 0,
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM auth_profile_store").get()).toEqual({
        count: 0,
      });
    } finally {
      database.close();
    }
  });

  it("preserves a schema-only legacy agent database with a blank owner as advisory", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, blocker: {}, digest: {} } },
    };
    const databasePath = seedSchemaOnlyLegacyAgentDatabase(stateDir, { agentId: "   " });

    const automatic = await autoMigrateLegacyState({ cfg, env, homedir: () => root });
    expect(automatic.warnings).toContainEqual(
      expect.stringContaining("agent schema owner is missing or blank"),
    );
    expect(fsSync.existsSync(databasePath)).toBe(true);
    expect(fsSync.existsSync(path.join(stateDir, "agents", "main", "agent"))).toBe(false);

    const doctor = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(doctor.skipped).toBe(false);
    expect(doctor.warnings).toContainEqual(
      expect.stringContaining("agent schema owner is missing or blank"),
    );
    expect(doctor.notices ?? []).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
  });

  it("keeps legacy files with a missing system agent advisory at startup and actionable in Doctor", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "missing" } },
        entries: { main: {}, blocker: {}, digest: {} },
      },
    };
    const legacyAgentPath = path.join(stateDir, "agent", "settings.json");
    fsSync.mkdirSync(path.dirname(legacyAgentPath), { recursive: true });
    fsSync.writeFileSync(legacyAgentPath, '{"legacy":true}\n');

    const automatic = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(automatic.skipped).toBe(false);
    expect(automatic.warnings).toEqual([]);
    expect(automatic.notices).toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(fsSync.readFileSync(legacyAgentPath, "utf8")).toBe('{"legacy":true}\n');

    const doctor = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(doctor.skipped).toBe(false);
    expect(doctor.warnings).toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(doctor.notices ?? []).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(fsSync.readFileSync(legacyAgentPath, "utf8")).toBe('{"legacy":true}\n');
  });

  it("leaves legacy files for Doctor repair with the system agent", async () => {
    const targetAgentId = "digest";
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: targetAgentId } },
        entries: { main: {}, blocker: {}, digest: {} },
      },
    } satisfies OpenClawConfig;
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const legacySessionsDir = path.join(stateDir, "sessions");
    const legacyAgentDir = path.join(stateDir, "agent");
    await fs.mkdir(legacySessionsDir, { recursive: true });
    await fs.mkdir(legacyAgentDir, { recursive: true });
    await writeJsonFixture(path.join(legacySessionsDir, "sessions.json"), {
      legacy: { sessionId: "legacy-session", updatedAt: 1 },
    });
    await fs.writeFile(path.join(legacySessionsDir, "legacy-session.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(legacyAgentDir, "settings.json"), '{"legacy":true}\n', "utf8");
    const legacyStorePath = path.join(legacySessionsDir, "sessions.json");
    const legacyBytes = await fs.readFile(legacyStorePath);
    await autoMigrateLegacyState({ cfg, env, homedir: () => root });
    await expect(fs.readFile(legacyStorePath)).resolves.toEqual(legacyBytes);
    await expect(
      fs.readFile(path.join(legacySessionsDir, "legacy-session.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      now: () => 1234,
      doctorOnlyStateMigrations: true,
    });

    expect(result.warnings).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(result.notices ?? []).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    await expect(fs.readFile(legacyStorePath)).resolves.toEqual(legacyBytes);
    await expect(
      fs.readFile(path.join(legacySessionsDir, "legacy-session.jsonl"), "utf8"),
    ).resolves.toBe("{}\n");
    await expect(
      fs.readFile(path.join(stateDir, "agents", targetAgentId, "agent", "settings.json"), "utf8"),
    ).resolves.toContain('"legacy":true');
    await native.expectMissingPath(legacyAgentDir);
  });

  it("keeps unreadable legacy agent databases blocking", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, blocker: {}, digest: {} } },
    };
    const databasePath = path.join(stateDir, "agent", "openclaw-agent.sqlite");
    fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
    fsSync.writeFileSync(databasePath, "not a SQLite database");
    const settingsPath = path.join(stateDir, "agent", "settings.json");
    fsSync.writeFileSync(settingsPath, '{"legacy":true}\n');

    const result = await autoMigrateLegacyState({ cfg, env, homedir: () => root });

    expect(result.warnings).toContainEqual(
      expect.stringContaining("Failed inspecting legacy agent database"),
    );
    expect(result.notices ?? []).not.toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(fsSync.readFileSync(databasePath, "utf8")).toBe("not a SQLite database");
    expect(fsSync.readFileSync(settingsPath, "utf8")).toBe('{"legacy":true}\n');
  });

  it("detects no plugin-state migration warnings after the startup lease creates fresh state", async () => {
    const { root, env } = native.createMigrationContext(await createTempDir());
    const detectLegacyState = vi.fn(async ({ context }: { context: unknown }) => {
      const pluginState = (context as PluginDoctorStateMigrationContext).openPluginStateKeyedStore({
        namespace: "fresh-start-detection",
        maxEntries: 10,
      });
      await expect(pluginState.lookup("legacy")).resolves.toBeUndefined();
      await expect(pluginState.entries()).resolves.toEqual([]);
      return null;
    });
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "fixture",
        migration: {
          id: "fixture-fresh-start-plugin-state",
          label: "Fixture fresh-start plugin state",
          detectLegacyState,
          migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
        },
      },
    ];

    const lease = await native.acquireStartupMigrationLeaseWithWait({
      env,
      timeoutMs: 0,
    });
    try {
      const databasePath = native.resolveOpenClawStateSqlitePath(env);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: native.OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        database.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: native.OPENCLAW_STATE_SCHEMA_VERSION });
      database.close();

      const detected = await detectLegacyStateMigrations({
        cfg: native.createConfig(),
        env,
        homedir: () => root,
      });

      expect(detectLegacyState).toHaveBeenCalledOnce();
      expect(detected.warnings).toEqual([]);
    } finally {
      lease.release();
    }
  });

  it("scopes doctor channel ingress queue access to the plugin's own channels", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const discovered: string[] = [];
    const offeredChannelIds: string[][] = [];
    const detectionMutableLanes: unknown[] = [];
    const detectionPending: number[] = [];
    const detectionMutatorsReachable: string[] = [];
    // Detection is now read-only, so the account has to already exist. Seeding it
    // directly is also what makes the inspection assertion meaningful.
    await native
      .createChannelIngressQueue<{ note: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
      })
      .enqueue("ingress-scope-seed", { note: "seeded" });
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "line",
        channelIds: ["line"],
        migration: {
          id: "line-ingress-scope-test",
          label: "LINE ingress scope test",
          async detectLegacyState({ context }) {
            const queues = context.channelIngressQueues ?? [];
            // The host hands out only owner-bound lanes; a foreign channel has no entry.
            offeredChannelIds.push(queues.map((entry) => entry.channelId));
            const line = queues.find((entry) => entry.channelId === "line");
            // Detection runs before exclusive state ownership, so the mutable lane is
            // absent entirely - there is no handle to write through, not merely a
            // handle that refuses.
            detectionMutableLanes.push(line?.openChannelIngressQueue);
            const inspection = line?.openChannelIngressQueueForInspection<{ note: string }>({
              accountId: "default",
            });
            // A narrowed return type still hands over every method at runtime, so the
            // projection is checked as a value: detection must not be able to reach a
            // mutator even by casting the type away.
            for (const method of [
              "enqueue",
              "claimNext",
              "claim",
              "complete",
              "release",
              "fail",
              "delete",
              "recoverStaleClaims",
              "prune",
              "resubmit",
              "refreshClaim",
            ]) {
              detectionMutatorsReachable.push(
                typeof (inspection as Record<string, unknown> | undefined)?.[method],
              );
            }
            detectionPending.push((await inspection?.listPending({ limit: "all" }))?.length ?? -1);
            discovered.push(...((await line?.listChannelIngressQueueAccountIds()) ?? []));
            return null;
          },
          migrateLegacyState: () => ({ changes: [], warnings: [] }),
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: native.createConfig(),
      env,
      homedir: () => root,
    });

    expect(
      detected.warnings.filter((warning) => warning.includes("LINE ingress scope test")),
    ).toStrictEqual([]);
    // Detection can run more than once per pass; every run must see the same
    // owner-bound lane set and the seeded account.
    expect(offeredChannelIds.length).toBeGreaterThan(0);
    for (const channelIds of offeredChannelIds) {
      expect(channelIds).toStrictEqual(["line"]);
    }
    expect(discovered.length).toBeGreaterThan(0);
    expect([...new Set(discovered)]).toStrictEqual(["default"]);
    // The authority chain: no detection run was ever handed a mutable lane, while the
    // inspection projection still answered on the same access entry.
    expect(detectionMutableLanes.length).toBeGreaterThan(0);
    expect(detectionMutableLanes.every((lane) => lane === undefined)).toBe(true);
    expect(detectionPending.length).toBeGreaterThan(0);
    expect(detectionPending.every((count) => count === 1)).toBe(true);
    // Not one mutating method is present on the inspection object at runtime.
    expect(detectionMutatorsReachable.length).toBeGreaterThan(0);
    expect([...new Set(detectionMutatorsReachable)]).toStrictEqual(["undefined"]);
    // And nothing detection did reached durable state: the seeded row is still the
    // only row, so no detection-time write landed.
    const afterDetection = await native
      .createChannelIngressQueue<{ note: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
      })
      .listPending({ limit: "all", orderBy: "received" });
    expect(afterDetection.map((row) => row.id)).toStrictEqual(["ingress-scope-seed"]);
  });

  it("revokes migration ingress queue access once the repair section returns", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    let retainedOpen:
      | ((options?: { accountId?: string }) => { enqueue: (...args: never[]) => unknown })
      | undefined;
    let retainedQueue: { enqueue: (id: string, payload: unknown) => Promise<unknown> } | undefined;
    let mutableLanePresentDuringMigration = false;
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "line",
        channelIds: ["line"],
        migration: {
          id: "line-ingress-revocation-test",
          label: "LINE ingress revocation test",
          detectLegacyState: () => ({ preview: ["ingress revocation preview"] }),
          async migrateLegacyState({ context }) {
            const line = (context.channelIngressQueues ?? []).find(
              (entry) => entry.channelId === "line",
            );
            const open = line?.openChannelIngressQueue;
            mutableLanePresentDuringMigration = open !== undefined;
            if (open) {
              // Inside the locked section the lane works, and both handles are kept so
              // the same objects can be driven again after the section returns.
              const queue = open<{ note: string }>({ accountId: "default" });
              await queue.enqueue("inside-section", { note: "owned" });
              retainedOpen = open as unknown as typeof retainedOpen;
              retainedQueue = queue as unknown as typeof retainedQueue;
            }
            return { changes: ["ingress revocation test migrated"], warnings: [] };
          },
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: native.createConfig(),
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      config: native.createConfig(),
      env,
    });

    expect(mutableLanePresentDuringMigration).toBe(true);
    expect(result.changes).toContain("ingress revocation test migrated");

    // Durable-state evidence: the throw alone does not prove the write never reached
    // SQLite. Hash the real database file and re-read the rows through a fresh queue,
    // so a post-section mutation would have to surface as a changed digest.
    const sqlitePath = native.resolveOpenClawStateSqlitePath(env);
    // Hash the write-ahead log alongside the main file: committed rows can sit in the
    // WAL. The SHM file is coordination state and can change during a read-only query.
    const digest = () => {
      const hash = createHash("sha256");
      for (const suffix of ["", "-wal"]) {
        const file = `${sqlitePath}${suffix}`;
        hash.update(suffix);
        hash.update(fsSync.existsSync(file) ? fsSync.readFileSync(file) : Buffer.alloc(0));
      }
      return hash.digest("hex");
    };
    const readPendingIds = async () =>
      (
        await native
          .createChannelIngressQueue<{ note: string }>({
            channelId: "line",
            accountId: "default",
            stateDir,
          })
          .listPending({ limit: "all", orderBy: "received" })
      ).map((row) => row.id);

    const beforeIds = await readPendingIds();
    const beforeDigest = digest();
    // The write the locked section DID make is on disk, so the file is a live witness.
    expect(beforeIds).toContain("inside-section");

    // The factory rejects synchronously; the retained queue rejects through its async API.
    expect(() => retainedOpen?.({ accountId: "default" })).toThrow(
      /ingress queue access has expired/i,
    );
    await expect(retainedQueue?.enqueue("after-section", { note: "leaked" })).rejects.toThrow(
      /ingress queue access has expired/i,
    );

    const afterIds = await readPendingIds();
    expect(afterIds).toStrictEqual(beforeIds);
    expect(digest()).toBe(beforeDigest);
  });

  it("withholds ingress queue access from an untrusted plugin owner", async () => {
    const { root, env } = native.createMigrationContext(await createTempDir());
    const detectionLanes: unknown[] = [];
    const migrationLanes: unknown[] = [];
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "line",
        channelIds: ["line"],
        // Same decision the runtime proxy makes for openChannelIngressQueue: an
        // activated workspace plugin is neither bundled nor a trusted official install.
        trustedForDurableStores: false,
        migration: {
          id: "line-ingress-trust-test",
          label: "LINE ingress trust test",
          detectLegacyState({ context }) {
            detectionLanes.push(context.channelIngressQueues);
            return { preview: ["ingress trust preview"] };
          },
          migrateLegacyState({ context }) {
            migrationLanes.push(context.channelIngressQueues);
            return { changes: ["ingress trust test ran"], warnings: [] };
          },
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg: native.createConfig(),
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      config: native.createConfig(),
      env,
    });

    expect(result.changes).toContain("ingress trust test ran");
    // Neither phase is handed a lane at all - not an empty list, and not a lane that
    // refuses on use. There is nothing to reach the durable queue through.
    expect(detectionLanes.length).toBeGreaterThan(0);
    expect(migrationLanes.length).toBeGreaterThan(0);
    expect(detectionLanes.every((lanes) => lanes === undefined)).toBe(true);
    expect(migrationLanes.every((lanes) => lanes === undefined)).toBe(true);
  });

  it("rejects a recovery predicate that resolves after the repair section returns", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    await native.expectRecoveryPredicateRefusedAfterRepair({
      stateDir,
      runMigration: async (migration) => {
        pluginDoctorStateMigrationEntries.entries = [
          { pluginId: "line", channelIds: ["line"], migration },
        ];
        const detected = await detectLegacyStateMigrations({
          cfg: native.createConfig(),
          env,
          homedir: () => root,
        });
        const result = await runLegacyStateMigrations({
          detected,
          config: native.createConfig(),
          env,
        });
        expect(result.changes).toContain("ingress latch test migrated");
      },
    });
  });

  it("excludes post-session plugin repair from legacy migration detection and execution", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {} },
      },
    };
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await writeJsonFixture(legacyStorePath, {
      legacy: { sessionId: "imported-session", updatedAt: 1 },
    });
    const detect = vi.fn(({ context }: { context: unknown }) => {
      expect(
        (context as PluginDoctorStateMigrationContext).deletePluginStateEntriesIfUnchanged,
      ).toBeUndefined();
      return { preview: ["fixture plugin migration"] };
    });
    const postSessionDetect = vi.fn(() => ({ preview: ["post-session repair"] }));
    const postSessionMigrate = vi.fn(() => ({ changes: ["post-session phase"], warnings: [] }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "fixture",
        migration: {
          id: "fixture-legacy",
          label: "Fixture legacy plugin migration",
          doctorOnly: true,
          detectLegacyState: detect,
          migrateLegacyState({ context }) {
            expect(fsSync.existsSync(legacyStorePath)).toBe(true);
            expect(
              (context as PluginDoctorStateMigrationContext).deletePluginStateEntriesIfUnchanged,
            ).toBeUndefined();
            return { changes: ["legacy phase"], warnings: [] };
          },
        },
      },
      {
        pluginId: "fixture",
        migration: {
          id: "fixture-after-session-repair",
          label: "Fixture post-session plugin migration",
          doctorOnly: true,
          phase: "after-session-repair",
          detectLegacyState: postSessionDetect,
          migrateLegacyState: postSessionMigrate,
        },
      },
    ];

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toEqual([]);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(postSessionDetect).not.toHaveBeenCalled();
    expect(postSessionMigrate).not.toHaveBeenCalled();
    expect(result.changes).toContain("legacy phase");
    expect(result.changes).not.toContain("post-session phase");
  });

  it("restores retained Memory Core host events only for explicit plugin-only Doctor repair", async () => {
    const root = await fs.realpath(await createTempDir());
    const stateDir = path.join(root, ".openclaw");
    const workspaceDir = path.join(root, "workspace");
    const eventPath = path.join(workspaceDir, "memory", ".dreams", "events.jsonl");
    const env = native.createEnv(stateDir);
    const cfg = {
      agents: { entries: { main: { workspace: workspaceDir } } },
    } as OpenClawConfig;
    const event = {
      type: "memory.recall.recorded",
      timestamp: "2026-07-01T00:00:00.000Z",
      query: "retained before upgrade",
      resultCount: 0,
      results: [],
    } as const;
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.writeFile(eventPath, `${JSON.stringify(event)}\n`, "utf8");

    const { stateMigrations } = (await import(
      /* @vite-ignore */ new URL(
        "../../extensions/memory-core/doctor-contract-api.ts",
        import.meta.url,
      ).href
    )) as { stateMigrations: PluginDoctorStateMigration[] };
    const migration = stateMigrations.find(
      (candidate) => candidate.id === "memory-core-host-events-jsonl-to-sqlite",
    );
    expect(migration).toBeDefined();
    if (!migration) {
      throw new Error("Expected the bundled Memory Core host-event Doctor migration");
    }
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: migration.id,
          label: migration.label,
          doctorOnly: migration.doctorOnly,
          detectLegacyState: (params) =>
            migration.detectLegacyState({
              ...params,
              context: params.context as PluginDoctorStateMigrationContext,
            }),
          migrateLegacyState: async (params) => {
            const result = await migration.migrateLegacyState({
              ...params,
              context: params.context as PluginDoctorStateMigrationContext,
            });
            return result;
          },
        },
      },
    ];

    const automatic = await native.autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });
    expect(automatic.warnings).toEqual([]);
    expect(automatic.changes).not.toContain(
      "Migrated Memory Core host events -> SQLite plugin state (1 new row(s))",
    );
    await expect(native.readMemoryHostEventRecords({ workspaceDir, env })).resolves.toEqual([]);
    await expect(fs.stat(eventPath)).resolves.toBeDefined();

    const repaired = await native.autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(repaired.warnings).toEqual([]);
    expect(repaired.changes).toContain(
      "Migrated Memory Core host events -> SQLite plugin state (1 new row(s))",
    );
    await expect(native.readMemoryHostEventRecords({ workspaceDir, env })).resolves.toEqual([
      event,
    ]);
    await native.expectMissingPath(eventPath);
    await expect(fs.stat(`${eventPath}.migrated`)).resolves.toBeDefined();

    const rewritten = `${JSON.stringify({ ...event, query: "rewritten archive" })}\n`;
    await fs.writeFile(`${eventPath}.migrated`, rewritten);
    const continued = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(
      continued.stepReceipts.find((receipt) => receipt.id === "plugin-doctor-state"),
    ).toMatchObject({
      outcome: "warning",
      warnings: [expect.stringContaining("changed other than by append")],
    });
    expect(() => native.throwIfDoctorStateMigrationRefused(continued.stepReceipts)).not.toThrow();
    expect(continued.stepReceipts.some((receipt) => receipt.outcome === "refused")).toBe(false);
    await expect(native.readMemoryHostEventRecords({ workspaceDir, env })).resolves.toEqual([
      event,
    ]);
    await expect(fs.readFile(`${eventPath}.migrated`, "utf8")).resolves.toBe(rewritten);
  });

  it("checks automatic migrations independently for each state directory", async () => {
    const root = await createTempDir();
    const stateDirs = [path.join(root, "state-a"), path.join(root, "state-b")];
    const detectedStateDirs: string[] = [];
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-state-dir-latch-test",
          label: "Memory Core state-dir latch test",
          detectLegacyState: ({ stateDir }) => {
            detectedStateDirs.push(stateDir);
            return null;
          },
          migrateLegacyState: () => ({ changes: [], warnings: [] }),
        },
      },
    ];

    for (const stateDir of stateDirs) {
      await autoMigrateLegacyState({
        cfg: native.createConfig(),
        env: native.createEnv(stateDir),
        homedir: () => root,
      });
    }

    expect(new Set(detectedStateDirs)).toStrictEqual(new Set(stateDirs));
  });

  it("runs legacy state migrations and canonicalizes the per-agent session store", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture({ includePreKey: true });
    cfg.session = { ...cfg.session, mainKey: "Desk" };
    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const targetStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      unknown
    >;
    targetStore["agent:main:desk"] = { sessionId: "explicit-foreign", updatedAt: 30 };
    targetStore["voice:15550001111"] = native.createLegacyAcpSessionEntry(
      "shared-voice",
      20,
      "worker-1",
      "shared-runtime",
      20,
    );
    targetStore["agent:worker-1:acp:task"] = native.createLegacyAcpSessionEntry(
      "canonical-acp",
      15,
      "worker-1",
      "canonical-runtime",
      15,
    );
    targetStore["Agent:main:desk"] = { sessionId: "mixed-case-foreign", updatedAt: 40 };
    targetStore["legacy-prototype"] = {
      sessionId: "prototype-row",
      updatedAt: 10,
      sessionFile: "trace.jsonl",
    };
    await fs.writeFile(targetStorePath, `${JSON.stringify(targetStore, null, 2)}\n`, "utf8");
    cfg.session = { ...cfg.session, store: targetStorePath };

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      pluginSessionStoreAgentIds: ["worker-1"],
    });
    expect(detected.sessions.preserveAmbiguousKeys).toBe(false);
    expect(detected.sessions.preserveForeignMainAliases).toBe(true);
    expect(detected.sessions.targetStoreAliases.hasDistinctAliases).toBe(false);
    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      now: () => 1234,
    });
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      "Migrated 2 chatapp/alpha allowFrom entries → shared SQLite state",
      `Moved MobileAuth auth creds.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "creds.json")}`,
      `Moved MobileAuth auth pre-key-1.json → ${path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json")}`,
      "Canonicalized 4 legacy session key(s)",
      "Migrated 2 ACP session metadata rows → shared SQLite state",
      "Moved agent file settings.json → agents/worker-1/agent",
    ]);
    expect(result.stepReceipts.find((receipt) => receipt.id === "sessions")).toMatchObject({
      outcome: "completed",
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "acp-session-metadata"),
    ).toMatchObject({ outcome: "completed" });
    expect(result.stepReceipts.find((receipt) => receipt.id === "agent-dir")).toMatchObject({
      outcome: "completed",
    });

    const mergedStore = JSON.parse(
      await fs.readFile(
        path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json"),
        "utf8",
      ),
    ) as Record<string, { sessionId: string; sessionFile?: string; acp?: unknown }>;
    expect(mergedStore["group:mobile-room"]).toBeUndefined();
    expect(mergedStore["group:legacy-room"]).toBeUndefined();
    expect(mergedStore["agent:worker-1:unknown:group:mobile-room"]?.sessionId).toBe(
      "group-session",
    );
    expect(mergedStore["agent:worker-1:unknown:group:legacy-room"]?.sessionId).toBe(
      "generic-group-session",
    );
    expect(mergedStore["agent:main:desk"]?.sessionId).toBe("explicit-foreign");
    expect(mergedStore["Agent:main:desk"]?.sessionId).toBe("mixed-case-foreign");
    expect(mergedStore["voice:15550001111"]).toBeUndefined();
    expect(mergedStore["agent:worker-1:voice:15550001111"]?.sessionId).toBe("shared-voice");
    expect(mergedStore["agent:worker-1:voice:15550001111"]?.acp).toBeUndefined();
    expect(mergedStore["agent:worker-1:legacy-prototype"]?.sessionId).toBe("prototype-row");
    expect(mergedStore["agent:worker-1:legacy-prototype"]).not.toHaveProperty("sessionFile");
    expect(mergedStore["agent:worker-1:acp:task"]?.acp).toBeUndefined();

    await expect(fs.readFile(path.join(stateDir, "sessions", "trace.jsonl"), "utf8")).resolves.toBe(
      "{}\n",
    );
    await expect(
      fs.readFile(path.join(stateDir, "sessions", "sessions.json"), "utf8"),
    ).resolves.toContain("legacy-direct");

    await expect(
      fs.readFile(path.join(stateDir, "agents", "worker-1", "agent", "settings.json"), "utf8"),
    ).resolves.toContain('"ok":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "mobileauth", "default", "creds.json"),
        "utf8",
      ),
    ).resolves.toContain('"auth":true');
    await expect(
      fs.readFile(
        path.join(stateDir, "credentials", "mobileauth", "default", "pre-key-1.json"),
        "utf8",
      ),
    ).resolves.toContain('"preKey":true');
    await expect(
      fs.readFile(path.join(stateDir, "credentials", "oauth.json"), "utf8"),
    ).resolves.toContain('"oauth":true');
    expect(native.readChannelPairingStateSnapshot("chatapp", env).allowFrom).toEqual({
      alpha: ["123", "456"],
    });
    await native.expectMissingPath(path.join(stateDir, "credentials", "chatapp-allowFrom.json"));
  });

  it("defers legacy migration when configured store identity is inaccessible", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await fs.writeFile(targetStorePath, '{"task":{"sessionId":"legacy","updatedAt":10}}\n', "utf8");
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await fs.writeFile(configuredStorePath, "{}\n", "utf8");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await writeJsonFixture(legacyStorePath, {
      "agent:main:task": { sessionId: "legacy", updatedAt: 10 },
    });
    const cfg = {
      session: { store: configuredStorePath },
      agents: { entries: { main: {} } },
    } as OpenClawConfig;
    const realStatSync = fsSync.statSync.bind(fsSync);
    const statSpy = vi.spyOn(fsSync, "statSync").mockImplementation((candidate) => {
      if (path.resolve(candidate.toString()) === configuredStorePath) {
        throw Object.assign(new Error("inaccessible store"), { code: "EACCES" });
      }
      return realStatSync(candidate);
    });
    let detected: Awaited<ReturnType<typeof detectLegacyStateMigrations>>;
    try {
      detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    } finally {
      statSpy.mockRestore();
    }

    expect(detected.sessions.targetStoreAliases.hasUnresolvedIdentity).toBe(true);
    const result = await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });

    expect(result.warnings).toContainEqual(
      expect.stringContaining("filesystem identity could not be established"),
    );
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toContain("legacy");
    await expect(fs.readFile(targetStorePath, "utf8")).resolves.toContain('"task"');
  });

  it("keeps the legacy source when its store write fails", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await fs.writeFile(targetStorePath, '{"task":{"sessionId":"legacy","updatedAt":10}}\n', "utf8");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await writeJsonFixture(legacyStorePath, {
      "agent:main:task": { sessionId: "legacy", updatedAt: 10 },
    });
    const cfg = {
      agents: { entries: { main: {} } },
    } as OpenClawConfig;
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const realSaveSessionStore = native.sessionStore.saveLegacySessionStore;
    const saveSpy = vi
      .spyOn(native.sessionStore, "saveLegacySessionStore")
      .mockImplementation(async (storePath, store, options) => {
        if (storePath === targetStorePath) {
          throw new Error("simulated alias write failure");
        }
        await realSaveSessionStore(storePath, store, options);
      });
    try {
      const result = await runLegacyStateMigrations({ detected, config: cfg, now: () => 1234 });
      expect(result.warnings).toContain("simulated alias write failure");
      expect(result.stepReceipts.find((receipt) => receipt.id === "sessions")).toMatchObject({
        outcome: "refused",
        refusal: { code: "step-threw", message: "simulated alias write failure" },
      });
    } finally {
      saveSpy.mockRestore();
    }

    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toContain("legacy");
  });

  it("preserves plugin ownership and receipts the alias refusal before dependent ACP work", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await writeJsonFixture(targetStorePath, {
      "agent:main:desk": { sessionId: "foreign-main", updatedAt: 30 },
      "agent:worker-1:main": native.createLegacyAcpSessionEntry(
        "worker-main",
        20,
        "worker-1",
        "legacy-runtime",
        20,
      ),
      "voice:15550001111": { sessionId: "legacy-voice", updatedAt: 10 },
    });
    const configuredStorePath = path.join(stateDir, "configured-sessions.json");
    await fs.link(targetStorePath, configuredStorePath);
    const cfg = {
      agents: { entries: { "worker-1": {} } },
      session: { mainKey: "desk", store: configuredStorePath },
      plugins: {
        entries: {
          "voice-call": { config: { agentId: "worker-1" } },
        },
      },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    const targetStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
      string,
      { sessionId: string }
    >;
    expect(targetStore["agent:main:desk"]?.sessionId).toBe("foreign-main");
    expect(targetStore["agent:worker-1:main"]?.sessionId).toBe("worker-main");
    expect(targetStore["agent:worker-1:desk"]).toBeUndefined();
    expect(targetStore["agent:worker-1:main"]).toHaveProperty("acp");
    expect(fsSync.statSync(configuredStorePath).ino).toBe(fsSync.statSync(targetStorePath).ino);
    const blockerIndex = result.stepReceipts.findIndex(
      (receipt) => receipt.id === "orphan-session-keys",
    );
    expect(blockerIndex).toBeGreaterThanOrEqual(0);
    expect(result.stepReceipts[blockerIndex]).toMatchObject({
      outcome: "refused",
      refusal: { code: "step-refused" },
    });
    for (const receipt of result.stepReceipts.slice(blockerIndex + 1)) {
      expect(receipt).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
      });
    }
    expect(result.stepReceipts.find((receipt) => receipt.id === "sessions")).toMatchObject({
      outcome: "refused",
      requiredness: "conditional",
      source: [],
      target: [],
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "acp-session-metadata"),
    ).toMatchObject({
      outcome: "refused",
      refusal: { code: "blocked-by-prior-refusal" },
    });
    expect(result.warnings).toEqual([
      expect.stringContaining(`aliased store ${configuredStorePath}`),
    ]);
  });

  it("preserves a singleton final symlink through all session migration phases", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const outsideStorePath = path.join(root, "outside-sessions.json");
    await writeJsonFixture(outsideStorePath, {
      "voice:15550001111": { sessionId: "outside-voice", updatedAt: 10 },
    });
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.symlink(outsideStorePath, storePath);
    const cfg = { agents: { entries: { main: {} } } } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect((await fs.lstat(storePath)).isSymbolicLink()).toBe(true);
    const outsideStore = JSON.parse(await fs.readFile(outsideStorePath, "utf8")) as Record<
      string,
      { sessionId: string }
    >;
    expect(outsideStore["voice:15550001111"]?.sessionId).toBe("outside-voice");
    const blockerIndex = result.stepReceipts.findIndex(
      (receipt) => receipt.id === "orphan-session-keys",
    );
    expect(blockerIndex).toBeGreaterThanOrEqual(0);
    expect(
      result.stepReceipts
        .filter((receipt) => receipt.refusal?.code === "step-refused")
        .map((receipt) => receipt.id),
    ).toEqual(["orphan-session-keys"]);
    for (const receipt of result.stepReceipts.slice(blockerIndex + 1)) {
      expect(receipt).toMatchObject({
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
      });
    }
    expect(result.warnings).toEqual([
      `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
  });

  it("preserves ACP metadata through a singleton fixed-store symlink", async () => {
    const { root, env } = native.createMigrationContext(await createTempDir());
    const outsideStorePath = path.join(root, "outside-sessions.json");
    const pendingKey = "agent:main:task";
    await writeJsonFixture(outsideStorePath, {
      [pendingKey]: native.createLegacyAcpSessionEntry(
        pendingKey,
        10,
        "main",
        "outside-runtime",
        10,
      ),
    });
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await fs.symlink(outsideStorePath, configuredStorePath);
    const cfg = {
      session: { store: configuredStorePath },
      agents: { entries: { main: {} } },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect((await fs.lstat(configuredStorePath)).isSymbolicLink()).toBe(true);
    const outsideStore = JSON.parse(await fs.readFile(outsideStorePath, "utf8")) as Record<
      string,
      { sessionId?: string; acp?: unknown }
    >;
    expect(outsideStore[pendingKey]?.sessionId).toBe(pendingKey);
    expect(outsideStore[pendingKey]?.acp).toBeDefined();
    expect(
      native.readAcpSessionMetaForEntry({
        sessionKey: pendingKey,
        entry: { sessionId: pendingKey, lifecycleRevision: undefined },
        agentId: "main",
        env,
      }),
    ).toBeUndefined();
    expect(result.warnings).toContain(
      `Deferred ACP metadata migration in final-component symlink store ${configuredStorePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    );
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
  });

  it("defers ACP metadata migration across hard-linked store paths", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const targetStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(targetStorePath), { recursive: true });
    await writeJsonFixture(targetStorePath, {
      "agent:main:task": native.createLegacyAcpSessionEntry(
        "canonical-acp",
        10,
        "main",
        "hardlink-runtime",
        10,
      ),
    });
    const configuredStorePath = path.join(root, "configured-sessions.json");
    await fs.link(targetStorePath, configuredStorePath);
    const cfg = {
      session: { store: configuredStorePath },
      agents: { entries: { main: {} } },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    for (const storePath of [targetStorePath, configuredStorePath]) {
      const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
        string,
        { acp?: unknown }
      >;
      expect(store["agent:main:task"]?.acp).toBeDefined();
    }
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
    expect(result.warnings).toContainEqual(
      expect.stringContaining("atomic replacement cannot update distinct filesystem aliases"),
    );
  });

  it("preserves foreign ACP aliases in templated plugin stores", async () => {
    const { root, env } = native.createMigrationContext(await createTempDir());
    const storeTemplate = path.join(root, "stores", "{agentId}", "sessions.json");
    const storePath = path.join(root, "stores", "voice", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeJsonFixture(storePath, {
      "agent:main:main": native.createLegacyAcpSessionEntry(
        "foreign-main",
        20,
        "voice",
        "foreign-runtime",
        20,
      ),
    });
    const cfg = {
      session: { scope: "global", store: storeTemplate },
      agents: { entries: { main: {} } },
      plugins: {
        entries: {
          "voice-call": { config: { agentId: "voice" } },
        },
      },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { sessionId: string; acp?: unknown }
    >;
    expect(store["agent:main:main"]?.sessionId).toBe("foreign-main");
    expect(store["agent:main:main"]?.acp).toBeDefined();
    expect(store.global).toBeUndefined();
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
    const orphanWarning = `Preserved 1 ambiguous session key(s) in potentially shared store ${storePath}`;
    const orphanReceipt = result.stepReceipts.find(
      (receipt) => receipt.id === "orphan-session-keys",
    );
    expect(orphanReceipt).toMatchObject({ outcome: "warning", warnings: [orphanWarning] });
    expect(orphanReceipt?.refusal).toBeUndefined();
    const acpWarningPrefix =
      "Preserved ACP metadata for 1 ambiguous session key(s) in potentially shared store ";
    expect(result.warnings.filter((warning) => warning.startsWith(acpWarningPrefix))).toHaveLength(
      1,
    );
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "acp-session-metadata"),
    ).toMatchObject({
      outcome: "refused",
      warnings: [`${acpWarningPrefix}${storePath}`],
      refusal: { code: "step-refused" },
    });
  });

  it("migrates malformed agent-shaped rows in single-owner plugin stores", async () => {
    const { root, env } = native.createMigrationContext(await createTempDir());
    const storeTemplate = path.join(root, "stores", "{agentId}", "sessions.json");
    const storePath = path.join(root, "stores", "voice", "sessions.json");
    const cases = [
      {
        legacyKey: "agent::matrix:channel:!RoomAbC:example.org",
        canonicalKey: "agent:voice:agent::matrix:channel:!RoomAbC:example.org",
        sessionId: "malformed-owner",
        runtimeSessionName: "malformed-runtime",
      },
      {
        legacyKey: "agent:_bad:opaque",
        canonicalKey: "agent:voice:agent:_bad:opaque",
        sessionId: "invalid-owner",
        runtimeSessionName: "invalid-runtime",
      },
    ];
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeJsonFixture(
      storePath,
      Object.fromEntries(
        cases.map(({ legacyKey, sessionId, runtimeSessionName }) => [
          legacyKey,
          native.createLegacyAcpSessionEntry(sessionId, 10, "voice", runtimeSessionName, 10),
        ]),
      ),
    );
    const cfg = {
      session: { store: storeTemplate },
      agents: { entries: { main: {} } },
      plugins: {
        entries: {
          "voice-call": { config: { agentId: "voice" } },
        },
      },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { sessionId: string; acp?: unknown }
    >;
    for (const { legacyKey, canonicalKey, sessionId, runtimeSessionName } of cases) {
      expect(store[legacyKey]).toBeUndefined();
      expect(store[canonicalKey]).toEqual({
        sessionId,
        updatedAt: 10,
        delivery: { kind: "none" },
      });
      expect(
        native.readAcpSessionMetaForEntry({
          sessionKey: canonicalKey,
          entry: { sessionId, lifecycleRevision: undefined },
          agentId: "voice",
          env,
        })?.runtimeSessionName,
      ).toBe(runtimeSessionName);
      expect(
        native.readAcpSessionMetaForEntry({
          sessionKey: legacyKey,
          entry: { sessionId, lifecycleRevision: undefined },
          agentId: "voice",
          env,
        }),
      ).toBeUndefined();
    }
    expect(result.changes).toContain("Migrated 2 ACP session metadata rows → shared SQLite state");
    expect(result.warnings).toHaveLength(0);
    const receipt = result.stepReceipts.find((entry) => entry.id === "acp-session-metadata");
    expect(receipt).toMatchObject({ outcome: "completed" });
    expect(receipt?.source).toEqual(expect.arrayContaining([{ kind: "path", path: storePath }]));
    expect(receipt?.target).toEqual(
      expect.arrayContaining([
        { kind: "path", path: storePath },
        { kind: "sqlite", path: native.resolveOpenClawStateSqlitePath(env) },
      ]),
    );
    expect(receipt?.source).not.toContainEqual(expect.objectContaining({ kind: "sqlite" }));
  });

  it("preserves multi-owner rows through coalesced templated-store migration", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const storeTemplate = path.join(
      stateDir,
      "agents",
      "{agentId}",
      "..",
      "main",
      "sessions",
      "sessions.json",
    );
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeJsonFixture(storePath, {
      "voice:15550001111": native.createLegacyAcpSessionEntry(
        "shared-voice",
        20,
        "voice",
        "shared-runtime",
        20,
      ),
      "agent:voice::matrix:channel:!room:example.org": native.createLegacyAcpSessionEntry(
        "malformed-owner",
        10,
        "voice",
        "malformed-runtime",
        10,
      ),
      "agent:_bad:opaque": native.createLegacyAcpSessionEntry(
        "invalid-owner",
        5,
        "voice",
        "invalid-runtime",
        5,
      ),
    });
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    await fs.mkdir(path.dirname(legacyStorePath), { recursive: true });
    await fs.writeFile(legacyStorePath, "{}\n", "utf8");
    const cfg = {
      session: { store: storeTemplate },
      agents: { entries: { main: {} } },
      acp: { allowedAgents: ["voice"] },
    } as OpenClawConfig;

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      { sessionId: string; acp?: unknown }
    >;
    expect(store["voice:15550001111"]?.sessionId).toBe("shared-voice");
    expect(store["voice:15550001111"]?.acp).toBeDefined();
    expect(store["agent:voice::matrix:channel:!room:example.org"]?.sessionId).toBe(
      "malformed-owner",
    );
    expect(store["agent:voice::matrix:channel:!room:example.org"]?.acp).toBeDefined();
    expect(store["agent:_bad:opaque"]?.sessionId).toBe("invalid-owner");
    expect(store["agent:_bad:opaque"]?.acp).toBeDefined();
    expect(store["agent:main:voice:15550001111"]).toBeUndefined();
    expect(store["agent:voice:voice:15550001111"]).toBeUndefined();
    expect(store["agent:main:agent:voice::matrix:channel:!room:example.org"]).toBeUndefined();
    expect(result.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
    const orphanWarning = `Preserved 3 ambiguous session key(s) in potentially shared store ${storePath}`;
    const orphanReceipt = result.stepReceipts.find(
      (receipt) => receipt.id === "orphan-session-keys",
    );
    expect(orphanReceipt).toMatchObject({ outcome: "warning", warnings: [orphanWarning] });
    expect(orphanReceipt?.refusal).toBeUndefined();
    const acpWarningPrefix =
      "Preserved ACP metadata for 3 ambiguous session key(s) in potentially shared store ";
    expect(result.warnings.filter((warning) => warning.startsWith(acpWarningPrefix))).toHaveLength(
      1,
    );
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "acp-session-metadata"),
    ).toMatchObject({
      outcome: "refused",
      warnings: [`${acpWarningPrefix}${storePath}`],
      refusal: { code: "step-refused" },
    });
  });

  it("leaves standalone ACP session metadata unchanged until Doctor repair", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const pendingKey = "agent:main:existing";
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeJsonFixture(storePath, {
      [pendingKey]: {
        sessionId: pendingKey,
        updatedAt: 20,
        displayName: "Pending ACP session",
        providerOverride: "test-provider",
        modelOverride: "test-model",
        modelOverrideSource: "user",
        acp: {
          backend: "test",
          agent: "main",
          runtimeSessionName: "existing-runtime",
          mode: "persistent",
          state: "idle",
          lastActivityAt: 20,
        },
      },
    });

    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const originalBytes = await fs.readFile(storePath);
    const readFile = vi.spyOn(fsSync, "readFileSync");
    try {
      const automatic = await autoMigrateLegacyState({ cfg, env, homedir: () => root });
      expect(readFile.mock.calls.map(([pathname]) => pathname)).not.toContain(storePath);
      expect(automatic.changes).toEqual([]);
    } finally {
      readFile.mockRestore();
    }
    await expect(fs.readFile(storePath)).resolves.toEqual(originalBytes);
    expect(
      native.readAcpSessionMetaForEntry({
        sessionKey: pendingKey,
        entry: { lifecycleRevision: undefined },
        agentId: "main",
        env,
      }),
    ).toBeUndefined();

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect(result.changes).toContain("Migrated 1 ACP session metadata row → shared SQLite state");
    const afterStore = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      {
        sessionId?: string;
        initializationPending?: boolean;
        acp?: unknown;
        displayName?: string;
        providerOverride?: string;
        modelOverride?: string;
        modelOverrideSource?: string;
      }
    >;
    expect(afterStore[pendingKey]).toMatchObject({
      initializationPending: true,
      displayName: "Pending ACP session",
      providerOverride: "test-provider",
      modelOverride: "test-model",
      modelOverrideSource: "user",
    });
    expect(afterStore[pendingKey]?.sessionId).toBeUndefined();
    expect(afterStore[pendingKey]?.acp).toBeUndefined();
    expect(
      native.readAcpSessionMetaForEntry({
        sessionKey: pendingKey,
        entry: { lifecycleRevision: undefined },
        agentId: "main",
        env,
      })?.runtimeSessionName,
    ).toBe("existing-runtime");

    const firstBytes = await fs.readFile(storePath, "utf8");
    const rerun = await rerunAutomaticMigrationAfterRestart({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(rerun.skipped).toBe(false);
    expect(rerun.warnings).toEqual([]);
    await expect(fs.readFile(storePath, "utf8")).resolves.toBe(firstBytes);
    expect(rerun.changes).not.toContain(
      "Migrated 1 ACP session metadata row → shared SQLite state",
    );
  });

  it("migrates multi-owner ACP metadata in one canonical session phase", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const storeTemplate = path.join(
      stateDir,
      "agents",
      "{agentId}",
      "..",
      "main",
      "sessions",
      "sessions.json",
    );
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await writeJsonFixture(storePath, {
      "agent:voice:main": native.createLegacyAcpSessionEntry(
        "voice-main",
        10,
        "voice",
        "voice-runtime",
        10,
      ),
      "agent:main:existing": native.createLegacyAcpSessionEntry(
        "existing-main",
        20,
        "main",
        "existing-runtime",
        20,
      ),
    });
    const cfg: OpenClawConfigWithLegacyRoster = {
      session: { mainKey: "desk", store: storeTemplate },
      agents: { list: [{ id: "main", default: true }, { id: "voice" }] },
    };

    const result = await autoMigrateLegacyState({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });

    expect(
      native.readAcpSessionMetaForEntry({
        sessionKey: "agent:main:existing",
        entry: { sessionId: "existing-main", lifecycleRevision: undefined },
        agentId: "main",
        env,
      })?.runtimeSessionName,
    ).toBe("existing-runtime");
    expect(
      native.readAcpSessionMetaForEntry({
        sessionKey: "agent:voice:desk",
        entry: { sessionId: "voice-main", lifecycleRevision: undefined },
        agentId: "voice",
        env,
      })?.runtimeSessionName,
    ).toBe("voice-runtime");
    expect(
      native.readAcpSessionMetaForEntry({
        sessionKey: "agent:voice:main",
        entry: { sessionId: "voice-main", lifecycleRevision: undefined },
        agentId: "voice",
        env,
      }),
    ).toBeUndefined();
    expect(result.changes).toContain("Migrated 2 ACP session metadata rows → shared SQLite state");
  });

  it("ignores a leftover update-check cache instead of refusing", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const sourcePath = path.join(stateDir, "update-check.json");
    const original = '{"lastAvailableVersion":"2026.9.7"}\n';
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(sourcePath, original);
    const params = { cfg: native.createConfig(), env, homedir: () => root };

    const detected = await detectLegacyStateMigrations(params);
    expect(detected.warnings).toEqual([]);
    const migrated = await autoMigrateLegacyState(params);
    expect(migrated.warnings).toEqual([]);
    await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(original);
  });

  it("previews and repairs the released audit ledger before other state migrations", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    const databasePath = await native.createLegacyAuditLedger(stateDir);
    const cfg = native.createConfig();

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.stateSchema.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Shared SQLite schema: audit event ledger → versioned message lifecycle schema",
    );

    const result = await native.withStateMigrationBackupForTest({ env }, () =>
      runLegacyStateMigrations({ detected, config: cfg, env }),
    );
    expect(result.warnings).toStrictEqual([]);
    expect(result.stepReceipts[0]).toMatchObject({
      id: "state-schema",
      outcome: "completed",
      changes: expect.arrayContaining([
        "Migrated shared state audit event ledger → versioned message lifecycle schema",
      ]),
    });

    native.closeOpenClawStateDatabaseForTest();
    const db = new DatabaseSync(databasePath);
    try {
      expect(
        db
          .prepare(
            "SELECT sequence, event_id, source_id, schema_version FROM audit_events WHERE event_id = ?",
          )
          .get("event-before-v2"),
      ).toEqual({
        sequence: 3,
        event_id: "event-before-v2",
        source_id: "run-before-v2:1:100:agent.run.started",
        schema_version: 1,
      });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: native.OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        db
          .prepare(
            "SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1",
          )
          .get(),
      ).toEqual({
        role: "global",
        schema_version: native.OPENCLAW_STATE_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }

    const after = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(after.preview).not.toContain(
      "- Shared SQLite schema: audit event ledger → versioned message lifecycle schema",
    );
  });

  it("repairs shared SQLite before discarding retired commitments JSON", async () => {
    const { root, stateDir, env } = native.createMigrationContext(await createTempDir());
    await native.createLegacyAuditLedger(stateDir);
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await writeJsonFixture(sourcePath, { version: 1, commitments: [{ id: "retired" }] });
    const cfg = native.createConfig();

    const runtime = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(runtime.commitments?.hasLegacy).toBe(false);
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.preview).toContain(
      "- Commitments: discard retired commitments/commitments.json rows without import, archive, or export",
    );

    const result = await native.withStateMigrationBackupForTest({ env }, () =>
      runLegacyStateMigrations({ detected, config: cfg, env }),
    );

    expect(result.warnings).toStrictEqual([]);
    const schemaChange = result.changes.indexOf(
      "Migrated shared state audit event ledger → versioned message lifecycle schema",
    );
    const discardChange = result.changes.indexOf(
      "Discarded retired commitments JSON with 1 row; no data was imported, archived, or exported.",
    );
    expect(schemaChange).toBeGreaterThanOrEqual(0);
    expect(discardChange).toBeGreaterThan(schemaChange);
    await native.expectMissingPath(sourcePath);
    expect(
      native
        .openOpenClawStateDatabase({ env })
        .db.prepare(
          "SELECT removed_source FROM migration_sources WHERE migration_kind = 'legacy-commitments-json'",
        )
        .get(),
    ).toEqual({ removed_source: 1 });
  });

  it("doctor receipts each worktree row discarded before the provisioned-file ledger", async () => {
    const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
    const db = native.openOpenClawStateDatabase({ env }).db;
    const insertWorktree = createWorktreeInserter(db, root, stateDir);
    insertWorktree("legacy-z", 1);
    insertWorktree("legacy-a", 2);
    insertWorktree("current", 3, "[]");

    const runtime = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(runtime.preview).not.toContain(
      "- Managed worktrees: discard rows without provisioned-file ledgers",
    );
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.preview).toContain(
      "- Managed worktrees: discard rows without provisioned-file ledgers",
    );
    insertWorktree("unplanned", 4);

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });
    expect(result.changes).toContain(
      "Discarded 2 legacy managed worktree rows; affected worktrees will provision fresh on next use",
    );
    const databaseEndpoint = {
      kind: "sqlite",
      path: native.resolveOpenClawStateSqlitePath(env),
    };
    expect(result.stepReceipts.find((receipt) => receipt.id === "managed-worktrees")).toMatchObject(
      {
        outcome: "completed",
        source: [
          databaseEndpoint,
          { kind: "owner", id: "core:managed-worktree:legacy-a" },
          { kind: "owner", id: "core:managed-worktree:legacy-z" },
        ],
        target: [databaseEndpoint],
      },
    );
    expect(
      native
        .openOpenClawStateDatabase({ env })
        .db.prepare("SELECT id FROM worktrees ORDER BY id")
        .all(),
    ).toEqual([{ id: "current" }, { id: "unplanned" }]);
  });

  it("refuses managed-worktree deletion atomically with every planned owner receipted", async () => {
    const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
    const db = native.openOpenClawStateDatabase({ env }).db;
    const insertWorktree = createWorktreeInserter(db, root, stateDir);
    for (const id of ["legacy-b", "legacy-a"]) {
      insertWorktree(id, 1);
    }
    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    const result = await runLegacyStateMigrations({
      detected,
      config: cfg,
      env,
      onStepReceipt: (receipt) => {
        if (receipt.id === "retired-core-state") {
          native.openOpenClawStateDatabase({ env }).db.exec("PRAGMA query_only = ON;");
        }
      },
    });

    expect(result.stepReceipts.find((receipt) => receipt.id === "managed-worktrees")).toMatchObject(
      {
        outcome: "refused",
        source: [
          { kind: "sqlite", path: native.resolveOpenClawStateSqlitePath(env) },
          { kind: "owner", id: "core:managed-worktree:legacy-a" },
          { kind: "owner", id: "core:managed-worktree:legacy-b" },
        ],
        refusal: { code: "step-threw" },
      },
    );
    expect(result.stepReceipts.find((receipt) => receipt.id === "shared-auth-store")).toMatchObject(
      {
        outcome: "refused",
        refusal: { code: "blocked-by-prior-refusal" },
      },
    );
    expect(
      native
        .openOpenClawStateDatabase({ env })
        .db.prepare("SELECT id FROM worktrees ORDER BY id")
        .all(),
    ).toEqual([{ id: "legacy-a" }, { id: "legacy-b" }]);
  });

  it.each(["plugin-only", "all"] as const)(
    "blocks %s migrations after shared schema repair fails",
    async (scope) => {
      const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
      const stateDbPath = path.join(stateDir, "state", "openclaw.sqlite");
      const configHealthPath = path.join(stateDir, "logs", "config-health.json");
      const configPath = path.join(stateDir, "openclaw.json");
      const sourceBytes = `${JSON.stringify({
        entries: { [configPath]: { lastObservedSuspiciousSignature: "leave-me" } },
      })}\n`;
      await fs.mkdir(path.dirname(stateDbPath), { recursive: true });
      await fs.mkdir(path.dirname(configHealthPath), { recursive: true });
      await fs.writeFile(configHealthPath, sourceBytes, "utf8");
      const db = new DatabaseSync(stateDbPath);
      try {
        db.exec(`PRAGMA user_version = ${native.OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
      } finally {
        db.close();
      }
      const detectLegacyState = vi.fn(() => ({ preview: ["plugin state"] }));
      const migrateLegacyState = vi.fn(() => ({
        changes: ["plugin state migrated"],
        warnings: [],
      }));
      pluginDoctorStateMigrationEntries.entries = [
        {
          pluginId: "memory-core",
          migration: {
            id: "memory-core-schema-failure-test",
            label: "Memory Core schema failure test migration",
            detectLegacyState,
            migrateLegacyState,
          },
        },
      ];

      const migrate =
        scope === "plugin-only"
          ? native.autoMigrateLegacyPluginDoctorState({
              config: cfg,
              env,
              homedir: () => root,
            })
          : autoMigrateLegacyState({ cfg, env, homedir: () => root });
      await expect(migrate).rejects.toThrow("Failed migrating shared state database schema");
      expect(detectLegacyState).not.toHaveBeenCalled();
      expect(migrateLegacyState).not.toHaveBeenCalled();
      await expect(fs.readFile(configHealthPath, "utf8")).resolves.toBe(sourceBytes);
      await expect(fs.stat(`${configHealthPath}.migrated`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("continues plugin doctor migrations when one detector throws", async () => {
    const { root, env, cfg } = await createDefaultMigrationFixture();
    const migrateLegacyState = vi.fn(() => ({
      changes: ["healthy plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "msteams",
        migration: {
          id: "msteams-malformed-config-test",
          label: "Microsoft Teams malformed config test migration",
          detectLegacyState: () => {
            throw new TypeError("config.agents.list is not iterable");
          },
          migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
        },
      },
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-healthy-config-test",
          label: "Memory Core healthy config test migration",
          detectLegacyState: () => ({ preview: ["healthy plugin state"] }),
          migrateLegacyState,
        },
      },
    ];

    const result = await native.autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([
      "Failed detecting Microsoft Teams malformed config test migration: TypeError: config.agents.list is not iterable",
    ]);
    expect(result.changes).toContain("healthy plugin state migrated");
    expect(migrateLegacyState).toHaveBeenCalledOnce();
  });

  it("requires exclusive state ownership before plugin doctor migrations", async () => {
    const { root, env, cfg } = await createDefaultMigrationFixture();
    native.openOpenClawStateDatabase({ env });
    native.closeOpenClawStateDatabaseForTest();
    const migrateLegacyState = vi.fn(() => ({
      changes: ["plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-lock-test",
          label: "Memory Core lock test migration",
          detectLegacyState: () => ({ preview: ["plugin state"] }),
          migrateLegacyState,
        },
      },
    ];
    const result = await native.withGatewayLockHeld(env, 18_791, () =>
      native.autoMigrateLegacyPluginDoctorState({ config: cfg, env, homedir: () => root }),
    );

    expect(result.changes).not.toContain("plugin state migrated");
    expect(result.warnings.join("\n")).toContain("exclusive state ownership is unavailable");
    expect(migrateLegacyState).not.toHaveBeenCalled();
  });

  it("skips stale plugin doctor plans when refresh detection fails", async () => {
    const { root, env, cfg } = await createDefaultMigrationFixture();
    const migrateLegacyState = vi.fn(() => ({
      changes: ["stale plugin state migrated"],
      warnings: [],
    }));
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-stale-plan-test",
          label: "Memory Core stale plan test migration",
          detectLegacyState: () => ({ preview: ["stale plugin state"] }),
          migrateLegacyState,
        },
      },
    ];
    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    expect(detected.pluginPlans?.hasLegacy).toBe(true);

    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-stale-plan-test",
          label: "Memory Core stale plan test migration",
          detectLegacyState: () => {
            throw new TypeError("config.agents.list is not iterable");
          },
          migrateLegacyState,
        },
      },
    ];

    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toContain(
      "Failed detecting Memory Core stale plan test migration: TypeError: config.agents.list is not iterable",
    );
    expect(result.changes).not.toContain("stale plugin state migrated");
    expect(migrateLegacyState).not.toHaveBeenCalled();
  });

  it("runs plugin doctor migrations against the canonical state dir after state-dir repair", async () => {
    await reloadStateDirFixtureGraph();
    const root = await createTempDir();
    const legacyStateDir = path.join(root, ".clawdbot");
    const canonicalStateDir = path.join(root, ".openclaw");
    await fs.mkdir(legacyStateDir, { recursive: true });
    await fs.writeFile(path.join(legacyStateDir, "legacy.txt"), "legacy", "utf8");
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: root };
    delete env.OPENCLAW_STATE_DIR;
    const cfg = native.createConfig();
    const detectedStateDirs: string[] = [];
    const migratedStateDirs: string[] = [];
    pluginDoctorStateMigrationEntries.entries = [
      {
        pluginId: "memory-core",
        migration: {
          id: "memory-core-state-dir-test",
          label: "Memory Core state dir test migration",
          detectLegacyState: ({ stateDir }) => {
            detectedStateDirs.push(stateDir);
            return { preview: ["plugin state"] };
          },
          migrateLegacyState: ({ stateDir }) => {
            migratedStateDirs.push(stateDir);
            return { changes: ["plugin state migrated"], warnings: [] };
          },
        },
      },
    ];

    const result = await native.autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env,
      homedir: () => root,
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("plugin state migrated");
    expect(detectedStateDirs).toStrictEqual([canonicalStateDir]);
    expect(migratedStateDirs).toStrictEqual([canonicalStateDir]);
    await fs.access(path.join(canonicalStateDir, "legacy.txt"));
  });

  it("routes explicit Doctor repair through the APNs SQLite importer", async () => {
    const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
    const pushDir = path.join(stateDir, "push");
    const sourcePath = path.join(pushDir, "apns-registrations.json");
    await fs.mkdir(pushDir, { recursive: true });
    await writeJsonFixture(sourcePath, {
      registrationsByNodeId: {
        "doctor-ios-node": {
          nodeId: "doctor-ios-node",
          [APNS_DEVICE_FIELD]: "abcd1234abcd1234abcd1234abcd1234",
          topic: "ai.openclaw.ios",
          environment: "sandbox",
          updatedAtMs: 1,
        },
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.apns.hasLegacy).toBe(true);
    expect(detected.preview).toContain("- APNs registrations: legacy JSON → shared SQLite state");

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toStrictEqual([]);
    await expect(native.loadApnsRegistration("doctor-ios-node", stateDir)).resolves.toMatchObject({
      nodeId: "doctor-ios-node",
      transport: "direct",
    });
    await native.expectMissingPath(sourcePath);
  });

  it("routes explicit Doctor repair through the node-host SQLite importer", async () => {
    const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
    const sourcePath = path.join(stateDir, "node.json");
    const fixtureDigest = ["fixture", "digest"].join("-");
    await fs.mkdir(stateDir, { recursive: true });
    await writeJsonFixture(sourcePath, {
      version: 1,
      nodeId: "doctor-node",
      token: "test-token-placeholder",
      displayName: "Doctor Node",
      gateway: {
        host: "gateway.example",
        port: 18443,
        tls: true,
        tlsFingerprint: fixtureDigest,
        contextPath: "/doctor",
      },
    });

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: true,
    });
    expect(detected.nodeHost.hasLegacy).toBe(true);
    expect(detected.preview).toContain(
      "- Node-host config: legacy node.json → shared SQLite state",
    );

    const result = await runLegacyStateMigrations({ detected, config: cfg, env });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated node-host config to shared SQLite state.");
    await expect(native.loadNodeHostConfig(env)).resolves.toStrictEqual({
      version: 1,
      nodeId: "doctor-node",
      displayName: "Doctor Node",
      gateway: {
        host: "gateway.example",
        port: 18443,
        tls: true,
        tlsFingerprint: fixtureDigest,
        contextPath: "/doctor",
      },
      installedAppsSharing: false,
    });
    await native.expectMissingPath(sourcePath);
  });

  it("reconciles missing promoted config health state without replacing current SQLite fields", async () => {
    const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
    const configPath = path.join(stateDir, "openclaw.json");
    const importedConfigPath = path.join(stateDir, "imported.json");
    const sourcePath = path.join(stateDir, "logs", "config-health.json");
    const legacyFingerprint = { hash: "legacy", bytes: 10 };
    const currentFingerprint = { hash: "current", bytes: 20 };
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await writeJsonFixture(sourcePath, {
      entries: {
        [configPath]: {
          lastKnownGood: legacyFingerprint,
          lastPromotedGood: legacyFingerprint,
          lastObservedSuspiciousSignature: "legacy:size-drop",
        },
        [importedConfigPath]: {
          lastKnownGood: legacyFingerprint,
          lastPromotedGood: legacyFingerprint,
        },
      },
    });
    insertConfigHealthRow(env, {
      config_path: configPath,
      last_known_good_json: JSON.stringify(currentFingerprint),
      last_promoted_good_json: null,
      last_observed_suspicious_signature: null,
    });

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Migrated 1 config health entry → shared SQLite state");
    expect(result.changes).toContain("Reconciled 1 config health entry → shared SQLite state");
    expect(readConfigHealthRows(env)).toEqual([
      {
        config_path: importedConfigPath,
        last_known_good_json: JSON.stringify(legacyFingerprint),
        last_promoted_good_json: JSON.stringify(legacyFingerprint),
        last_observed_suspicious_signature: null,
      },
      {
        config_path: configPath,
        last_known_good_json: JSON.stringify(currentFingerprint),
        last_promoted_good_json: JSON.stringify(legacyFingerprint),
        last_observed_suspicious_signature: null,
      },
    ]);
    await native.expectMissingPath(sourcePath);
    await expect(fs.readFile(`${sourcePath}.migrated`, "utf8")).resolves.toContain("legacy");
  });

  it("removes a regenerated config health source when its archive already exists", async () => {
    const { root, stateDir, env, cfg } = await createDefaultMigrationFixture();
    const configPath = path.join(stateDir, "openclaw.json");
    const sourcePath = path.join(stateDir, "logs", "config-health.json");
    const archivedPath = `${sourcePath}.migrated`;
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await writeJsonFixture(sourcePath, {
      entries: { [configPath]: { lastKnownGood: { hash: "legacy" } } },
    });
    await fs.writeFile(archivedPath, "existing archive", "utf8");
    insertConfigHealthRow(env, {
      config_path: configPath,
      last_known_good_json: JSON.stringify({ hash: "current" }),
      last_promoted_good_json: JSON.stringify({ hash: "promoted" }),
      last_observed_suspicious_signature: null,
    });

    const detected = await detectLegacyStateMigrations({ cfg, env, homedir: () => root });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toContain("Removed regenerated config health legacy source");
    expect(readConfigHealthRows(env)).toEqual([
      {
        config_path: configPath,
        last_known_good_json: JSON.stringify({ hash: "current" }),
        last_promoted_good_json: JSON.stringify({ hash: "promoted" }),
        last_observed_suspicious_signature: null,
      },
    ]);
    await native.expectMissingPath(sourcePath);
    await expect(fs.readFile(archivedPath, "utf8")).resolves.toBe("existing archive");
  });

  it("leaves malformed legacy config health state in place", async () => {
    const root = await createTempDir();
    const stateDir = path.join(root, ".openclaw");
    const cfg = native.createConfig();
    const sourcePath = path.join(stateDir, "logs", "config-health.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, "{ malformed", "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env: native.createEnv(stateDir),
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({ detected, config: cfg });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Failed reading legacy config health state");
    await fs.access(sourcePath);
    await native.expectMissingPath(`${sourcePath}.migrated`);
  });

  it("preserves a readable target store when normalization rejects an existing key", async () => {
    const { root, stateDir, env, cfg } = await createLegacyStateFixture();

    const targetStorePath = path.join(stateDir, "agents", "worker-1", "sessions", "sessions.json");
    const legacyStorePath = path.join(stateDir, "sessions", "sessions.json");
    const targetBytes = `${JSON.stringify(
      {
        desk: { sessionId: "valid-session", updatedAt: 50 },
        "agent:worker-1:desk:invalid": { sessionId: "../invalid", updatedAt: 60 },
      },
      null,
      2,
    )}\n`;
    const legacyBytes = await fs.readFile(legacyStorePath, "utf8");
    await fs.writeFile(targetStorePath, targetBytes, "utf8");

    const detected = await detectLegacyStateMigrations({
      cfg,
      env,
      homedir: () => root,
    });
    const result = await runLegacyStateMigrations({
      detected,
      now: () => 1234,
    });

    await expect(fs.readFile(targetStorePath, "utf8")).resolves.toBe(targetBytes);
    await expect(fs.readFile(legacyStorePath, "utf8")).resolves.toBe(legacyBytes);
    await expect(fs.readFile(path.join(stateDir, "sessions", "trace.jsonl"), "utf8")).resolves.toBe(
      "{}\n",
    );
    expect(result.changes.some((change) => change.startsWith("Merged sessions store"))).toBe(false);
    expect(result.changes.some((change) => change.startsWith("Moved trace.jsonl"))).toBe(false);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("normalization rejected 1 existing target session key"),
    );
  });

  it.runIf(process.platform !== "win32")(
    "preserves a key-shaped pending row during per-agent session key repair",
    async () => {
      const { root, stateDir, env, cfg } = await createLegacyStateFixture();

      const targetStorePath = path.join(
        stateDir,
        "agents",
        "worker-1",
        "sessions",
        "sessions.json",
      );
      const pendingKey = "agent:worker-1:desk";
      const transcriptKey = "agent:worker-1:desk:transcript";
      const ordinaryKey = "ordinary";
      const targetStore = {
        [pendingKey]: {
          sessionId: pendingKey,
          updatedAt: 50,
          displayName: "Pending desk",
          label: "pending-label",
          category: "triage",
          providerOverride: "test-provider",
          modelOverride: "test-model",
          modelOverrideSource: "user",
          groupActivation: "always",
          delivery: { kind: "none" },
        },
        [transcriptKey]: { sessionId: "trace", updatedAt: 60 },
        [ordinaryKey]: { sessionId: "ordinary-session", updatedAt: 70 },
      };
      await fs.writeFile(targetStorePath, `${JSON.stringify(targetStore, null, 2)}\n`, "utf8");
      await fs.writeFile(
        path.join(stateDir, "sessions", `${pendingKey}.jsonl`),
        '{"type":"session"}\n',
        "utf8",
      );

      const result = await autoMigrateLegacyState({
        cfg,
        env,
        homedir: () => root,
        now: () => 1234,
        doctorOnlyStateMigrations: true,
      });

      expect(result.warnings).toEqual([]);
      expect(result.changes).not.toContain("Rewrote migrated session transcript paths");
      await expect(
        fs.readFile(path.join(stateDir, "sessions", "trace.jsonl"), "utf8"),
      ).resolves.toBe("{}\n");
      await expect(
        fs.readFile(path.join(stateDir, "sessions", `${pendingKey}.jsonl`), "utf8"),
      ).resolves.toBe('{"type":"session"}\n');

      const afterStore = JSON.parse(await fs.readFile(targetStorePath, "utf8")) as Record<
        string,
        {
          sessionId?: string;
          sessionFile?: string;
          initializationPending?: boolean;
          updatedAt?: number;
          displayName?: string;
          label?: string;
          category?: string;
          providerOverride?: string;
          modelOverride?: string;
          modelOverrideSource?: string;
          groupActivation?: string;
          delivery?: { kind?: string };
        }
      >;
      expect(afterStore[pendingKey]).toMatchObject({
        initializationPending: true,
        updatedAt: 50,
        displayName: "Pending desk",
        label: "pending-label",
        category: "triage",
        providerOverride: "test-provider",
        modelOverride: "test-model",
        modelOverrideSource: "user",
        groupActivation: "always",
        delivery: { kind: "none" },
      });
      expect(afterStore[pendingKey]?.sessionId).toBeUndefined();
      expect(afterStore[transcriptKey]?.sessionId).toBe("trace");
      expect(afterStore[transcriptKey]?.sessionFile).toBeUndefined();
      expect(afterStore["agent:worker-1:ordinary"]?.sessionId).toBe("ordinary-session");

      const firstBytes = await fs.readFile(targetStorePath, "utf8");
      const rerun = await rerunAutomaticMigrationAfterRestart({
        cfg,
        env,
        homedir: () => root,
        now: () => 1234,
        doctorOnlyStateMigrations: true,
      });
      expect(rerun.skipped).toBe(false);
      expect(rerun.warnings).toEqual([]);
      await expect(fs.readFile(targetStorePath, "utf8")).resolves.toBe(firstBytes);
      expect(rerun.changes.some((change) => change.startsWith("Merged sessions store"))).toBe(
        false,
      );
      expect(rerun.changes.some((change) => change.startsWith("Moved "))).toBe(false);
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
