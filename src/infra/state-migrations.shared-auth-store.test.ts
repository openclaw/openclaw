import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import * as ownership from "../agents/auth-profiles/path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../agents/auth-profiles/path-resolve.native.js";
import { setAuthProfileOrder } from "../agents/auth-profiles/profiles.js";
import * as paths from "../agents/auth-profiles/shared-main-dir.js";
import * as bootstrap from "../agents/auth-profiles/shared-store-bootstrap.js";
import {
  loadPersistedAuthProfileStoreFromRows,
  prepareAgentAuthProfileRowsRead,
  readSharedAuthProfileRows,
} from "../agents/auth-profiles/sqlite-read.js";
import * as sqlite from "../agents/auth-profiles/sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
} from "../agents/auth-profiles/store-runtime.js";
import { upsertAuthProfileWithLockOrThrow } from "../agents/auth-profiles/upsert-with-lock.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../state/user-model-account-authority.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type { EngineConnection } from "./sql-connection.js";
import { readMainDatabasePosixLocks } from "./sqlite-posix-locks.test-support.js";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
import * as doctor from "./state-migrations.doctor.js";
import * as migration from "./state-migrations.shared-auth-store.js";

function row(db: EngineConnection, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).get(...params);
}
function rows(db: EngineConnection, sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).all(...params);
}

function inspectCopy(fixture: Awaited<ReturnType<typeof createEmptyFixture>>) {
  expect(fixture.detect({ env: fixture.env, artifactPreservingReadOnly: true })).toEqual({
    sourcePath: fixture.sourcePath,
    hasLegacy: true,
  });
}

function detectLegacy(env: NodeJS.ProcessEnv, homedir?: () => string, config?: OpenClawConfig) {
  return doctor.detectLegacyStateMigrations({
    cfg: { ...config, plugins: { enabled: false } },
    env,
    homedir,
    doctorOnlyStateMigrations: true,
    pluginSessionStoreAgentIds: [],
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
}

function readSource(db: EngineConnection, kind: "store" | "state") {
  return row(
    db,
    `SELECT ${kind}_json, updated_at FROM auth_profile_${kind} WHERE ${kind}_key = 'primary'`,
  );
}
function machineRow(db: EngineConnection, key: string, timestamps = false) {
  return row(
    db,
    `SELECT value_json${timestamps ? ", updated_at_ms" : ""} FROM config_machine_state WHERE state_key = ?`,
    key,
  );
}
function putMachine(db: EngineConnection, key: string, json: string, updatedAt: number) {
  db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(key, json, updatedAt);
}
function updateMachine(db: EngineConnection, key: string, json: string, updatedAt: number) {
  db.prepare(
    "UPDATE config_machine_state SET value_json = ?, updated_at_ms = ? WHERE state_key = ?",
  ).run(json, updatedAt, key);
}
function receiptRow(db: EngineConnection) {
  return row(
    db,
    "SELECT source_sha256, source_record_count, status, removed_source FROM migration_sources WHERE target_table = 'auth_profile_stores'",
  );
}
function completedReceipt(source: unknown) {
  return {
    source_sha256: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
    source_record_count: 1,
    status: "completed",
    removed_source: 1,
  };
}
function localAuth(agentDir: string) {
  return {
    store: sqlite.readPersistedAuthProfileStoreRaw(agentDir),
    state: sqlite.readPersistedAuthProfileStateRaw(agentDir),
  };
}
function sharedAuth(env: NodeJS.ProcessEnv) {
  return {
    store: sqlite.readPersistedSharedAuthProfileStoreRaw(env),
    state: sqlite.readPersistedSharedAuthProfileStateRaw(env),
  };
}

const NO_CHANGES = { changes: [], warnings: [] };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ownerStates: OpenClawTestState[] = [];
let ownerFixtureRun: Promise<void> | undefined;
let unregisterAfterClose: (() => void) | undefined;

function makeStore(profileId: string, key: string) {
  return {
    version: 1,
    profiles: { [profileId]: { type: "api_key" as const, provider: "openai", key } },
  };
}

afterEach(async () => {
  // Timeouts leave the callback running; join it before resetting env or deleting its stores.
  await ownerFixtureRun?.catch(() => {});
  ownerFixtureRun = undefined;
  vi.restoreAllMocks();
  sqlite.closeAuthProfileReadPool();
  await closeOpenClawAgentDatabasesAsync();
  unregisterAfterClose?.();
  unregisterAfterClose = undefined;
  closeOpenClawAgentDatabasesForTest();
  await stateDb.closeOpenClawStateDatabaseAsync();
  stateDb.closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  for (const state of ownerStates.splice(0).toReversed()) {
    await state.cleanup();
    expect(fs.existsSync(state.root)).toBe(false);
  }
});

async function createFixture() {
  const fixture = await createEmptyFixture(false);
  const { stateDir, env } = fixture;
  const mainAgentDir = paths.resolveSharedMainAuthAgentDir(env);
  const opsAgentDir = path.join(stateDir, "agents", "ops", "agent");
  const sharedStore = makeStore("openai:shared", "shared-key");
  const sharedState = {
    version: 1,
    order: { openai: ["openai:shared"] },
    lastGood: { openai: "openai:shared" },
  };
  const opsStore = makeStore("openai:ops", "ops-key");
  sqlite.writePersistedAuthProfileStoreRaw(sharedStore, mainAgentDir);
  sqlite.writePersistedAuthProfileStateRaw(sharedState, mainAgentDir);
  sqlite.writePersistedAuthProfileStoreRaw(opsStore, opsAgentDir);
  return { ...fixture, mainAgentDir, opsAgentDir, sharedStore, sharedState };
}

async function createEmptyFixture(createSourceDatabase: boolean, isolated = false) {
  const owner = isolated
    ? await createOpenClawTestState({ prefix: "openclaw-shared-auth-" })
    : undefined;
  if (owner) {
    ownerStates.push(owner);
  }
  const stateDir = owner?.stateDir ?? tempDirs.make("openclaw-shared-auth-empty-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", "");
  const env: NodeJS.ProcessEnv = owner?.env ?? {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_DIR: undefined,
  };
  const mainAgentDir = paths.resolveSharedMainAuthAgentDir(env);
  const sourcePath = sqlite.resolveAuthProfileDatabasePath(mainAgentDir);
  if (createSourceDatabase) {
    sqlite.writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, mainAgentDir);
    sqlite.deletePersistedAuthProfileStoreRaw(mainAgentDir);
  }
  return {
    env,
    stateDir,
    sourcePath,
    agentDir: () => mainAgentDir,
    detect: (
      overrides: Partial<Parameters<typeof migration.detectSharedAuthStoreMigration>[0]> = {},
    ) =>
      migration.detectSharedAuthStoreMigration({
        stateDir,
        doctorOnlyStateMigrations: true,
        ...overrides,
      }),
    migrate: (
      detected: Parameters<typeof migration.migrateSharedAuthStore>[0]["detected"],
      selectedEnv?: NodeJS.ProcessEnv,
      integrityCheck?: "full",
    ) => migration.migrateSharedAuthStore({ detected, stateDir, env: selectedEnv, integrityCheck }),
  };
}

it.each(["legacy-main", "state-db"])(
  "preserves copied auth SQLite artifacts during %s inspection",
  async (location) => {
    const fixture = await createEmptyFixture(false);
    const statePath = resolveOpenClawStateSqlitePath(fixture.env);
    const seedPath = path.join(tempDirs.make("openclaw-auth-wal-seed-"), "seed.sqlite");
    for (const target of [fixture.sourcePath, statePath]) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      using seed = new DatabaseSync(seedPath);
      seed.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE IF NOT EXISTS auth_profile_store (store_key TEXT, store_json TEXT, updated_at INTEGER);
            CREATE TABLE IF NOT EXISTS config_machine_state (state_key TEXT, value_json TEXT, updated_at_ms INTEGER);
            CREATE TABLE IF NOT EXISTS migration_sources (source_key TEXT, migration_kind TEXT, source_path TEXT, removed_source INTEGER, source_sha256 TEXT, report_json TEXT);
            PRAGMA wal_checkpoint(TRUNCATE);
          `);
      if (target === fixture.sourcePath) {
        seed
          .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)")
          .run(JSON.stringify(makeStore("openai:copied", "fixture-key")));
      } else {
        seed.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "agent_deletion_journal"));
        seed
          .prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)")
          .run(JSON.stringify({ location }));
        seed
          .prepare(
            "INSERT INTO migration_sources (source_key, migration_kind, source_path, removed_source) VALUES ('pending', 'shared-auth-store-state-db', ?, 0)",
          )
          .run(fixture.sourcePath);
      }
      fs.copyFileSync(seedPath, target);
      fs.copyFileSync(`${seedPath}-wal`, `${target}-wal`);
    }
    const inventory = () =>
      [fixture.sourcePath, statePath].flatMap((file) =>
        ["", "-wal", "-shm", "-journal"].map((suffix) => ({
          path: `${file}${suffix}`,
          bytes: fs.existsSync(`${file}${suffix}`) ? fs.readFileSync(`${file}${suffix}`) : null,
        })),
      );
    const before = inventory();
    expect(fs.existsSync(`${fixture.sourcePath}-shm`)).toBe(false);
    expect(fs.existsSync(`${statePath}-shm`)).toBe(false);
    inspectCopy(fixture);
    expect(inventory()).toEqual(before);
  },
);

describe("shared auth relocation lifecycle", () => {
  let state: Awaited<ReturnType<typeof createEmptyFixture>>;
  beforeEach(async () => {
    state = await createEmptyFixture(false, true);
  });
  const migrate = (sourcePath: string, integrityCheck?: "full") =>
    state.migrate({ sourcePath, hasLegacy: true }, state.env, integrityCheck);

  const credential = { type: "api_key" as const, provider: "openai", key: "relocated-key" };
  const store = { version: 1, profiles: { "openai:default": credential } };
  const rotation = { version: 1, order: { openai: ["openai:default"] } };
  function registerSourceClose(sourcePath: string, close: () => Promise<void>) {
    unregisterAfterClose = registerOpenClawAgentDatabaseAsyncResource({
      agentId: "main",
      path: sourcePath,
      revoke: () => {},
      close,
    });
  }

  it.each([undefined, "full"] as const)(
    "uses requested integrity coverage for shared credential relocation (%s)",
    async (integrityCheck) => {
      const { sourcePath } = state;
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      {
        using database = new DatabaseSync(sourcePath);
        database.exec(`${OPENCLAW_AGENT_SCHEMA_SQL};
        PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
        INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, created_at, updated_at)
        VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', 1, 1);
      `);
        database
          .prepare("INSERT INTO auth_profile_store VALUES ('primary', ?, 1)")
          .run(JSON.stringify(store));
        database
          .prepare("INSERT INTO auth_profile_state VALUES ('primary', ?, 1)")
          .run(JSON.stringify(rotation));
        // An unrelated index defect distinguishes QUICK from whole-database FULL.
        database.enableDefensive?.(false);
        database.exec(`
          DROP INDEX idx_agent_cache_updated;
          CREATE INDEX idx_agent_cache_updated ON cache_entries(scope, key, updated_at);
          INSERT INTO cache_entries (scope, key, value_json, updated_at)
          VALUES ('retained', 'history', '"untouched"', 1);
          PRAGMA writable_schema = ON;
          UPDATE sqlite_schema SET sql =
            'CREATE INDEX idx_agent_cache_updated ON cache_entries(scope, updated_at DESC, key)'
            WHERE name = 'idx_agent_cache_updated';
          PRAGMA writable_schema = OFF;
        `);
      }

      const result = await migrate(sourcePath, integrityCheck);
      if (integrityCheck === "full") {
        expect(result).toMatchObject({
          changes: [],
          warnings: [expect.stringMatching(/integrity_check.*idx_agent_cache_updated/su)],
        });
      } else {
        expect(result.warnings).toEqual([]);
        expect(
          await readSharedAuthProfileRows(captureOpenClawStateWorkerContext({ env: state.env })),
        ).toMatchObject({
          store: { status: "readable", raw: store },
          state: { status: "readable", raw: rotation },
        });
      }
      {
        using source = new DatabaseSync(sourcePath, { readOnly: true });
        expect(source.prepare("SELECT store_json FROM auth_profile_store").all()).toEqual(
          integrityCheck === "full" ? [{ store_json: JSON.stringify(store) }] : [],
        );
        expect(source.prepare("SELECT state_json FROM auth_profile_state").all()).toEqual(
          integrityCheck === "full" ? [{ state_json: JSON.stringify(rotation) }] : [],
        );
        expect(source.prepare("SELECT value_json FROM cache_entries").get()?.value_json).toBe(
          '"untouched"',
        );
      }
      if (integrityCheck !== "full") {
        // Successful QUICK relocation must not admit a later FULL runtime open.
        expect(() =>
          openOpenClawAgentDatabase({ agentId: "main", path: sourcePath, env: state.env }),
        ).toThrow(/integrity_check.*idx_agent_cache_updated/su);
      }
    },
  );

  it("joins pre-existing source resources before returning a migration read failure", async () => {
    sqlite.writePersistedAuthProfileStoreRaw({ version: 1, profiles: {} }, state.agentDir());
    const { sourcePath } = state;
    let drained = false;
    registerSourceClose(sourcePath, async () => {
      await setImmediate();
      drained = true;
    });
    vi.spyOn(bootstrap, "readSharedAuthLegacyRowsFromDatabase").mockImplementationOnce(() => {
      throw new Error("source read failed");
    });

    const result = await migrate(sourcePath);

    expect(result.warnings).toEqual([expect.stringContaining("source read failed")]);
    expect(drained).toBe(true);
  });

  it("revokes the source credential authority before relocation and cold-loads the shared credential", async () => {
    sqlite.writePersistedAuthProfileStoreRaw(store, state.agentDir());
    const { sourcePath } = state;
    const reader = prepareAgentAuthProfileRowsRead({
      databasePath: sourcePath,
      agentId: "main",
      env: state.env,
    });
    const authority = reader.captureCredentialAuthority("openai:default")!;
    authority.observe(credential);
    await reader.dispose();
    let deniedBeforeSourceRelease = false;
    registerSourceClose(sourcePath, async () => {
      expect(() => authority.readCurrentCredential()).toThrow();
      deniedBeforeSourceRelease = true;
    });
    const result = await migrate(sourcePath);
    expect(result.warnings).toEqual([]);
    expect(deniedBeforeSourceRelease).toBe(true);
    expect(() => authority.readCurrentCredential()).toThrow();
    const context = captureOpenClawStateWorkerContext({ env: state.env });
    const identity = `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`;
    const current = captureAuthProfileCredentialAuthority(
      context,
      { identity, databasePath: context.admission.databasePath },
      "openai:default",
    );
    const sharedRows = await readSharedAuthProfileRows(context);
    current.observe(
      loadPersistedAuthProfileStoreFromRows(sharedRows, context.admission.databasePath)?.profiles[
        "openai:default"
      ],
    );
    expect(current.readCurrentCredential()).toEqual(credential);
  });
});

it("does not pin runtime auth ownership during copied inspection", async () => {
  const fixture = await createEmptyFixture(false);
  inspectCopy(fixture);
  const statePath = resolveOpenClawStateSqlitePath(fixture.env);
  expect(fs.existsSync(statePath)).toBe(false);
  expect(ownership.getPreparedSharedAuthStoreOwnership(fixture.env)).toBeUndefined();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  {
    using database = new DatabaseSync(statePath);
    database.exec(`
        CREATE TABLE config_machine_state (state_key TEXT, value_json TEXT, updated_at_ms INTEGER);
        INSERT INTO config_machine_state VALUES ('auth.sharedStore', '{"location":"state-db"}', 1);
      `);
  }
  expect(prepareSharedAuthStoreOwnershipForNative(fixture.env)).toEqual({ location: "state-db" });
});

it.runIf(process.platform === "linux")(
  "preserves the live auth source's POSIX locks during copied inspection",
  async () => {
    const fixture = await createEmptyFixture(false);
    stateDb.openOpenClawStateDatabase({ env: fixture.env });
    fs.mkdirSync(path.dirname(fixture.sourcePath), { recursive: true });
    using writer = new DatabaseSync(fixture.sourcePath);
    writer.exec(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE auth_profile_store (store_key TEXT, store_json TEXT, updated_at INTEGER);
          INSERT INTO auth_profile_store VALUES ('primary', '{"version":1,"profiles":{}}', 1);
        `);
    const before = readMainDatabasePosixLocks(fixture.sourcePath);
    expect(before).toEqual([{ length: 510, pid: process.pid, start: 1073741826, type: "read" }]);
    inspectCopy(fixture);
    expect(readMainDatabasePosixLocks(fixture.sourcePath)).toEqual(before);
    expect(rows(writer, "SELECT store_key FROM auth_profile_store")).toEqual([
      { store_key: "primary" },
    ]);
  },
);

it("records ownership for an empty source database without reporting relocation", async () => {
  const fixture = await createEmptyFixture(true);
  const detected = fixture.detect();
  expect(detected.hasLegacy).toBe(true);
  expect(await fixture.migrate(detected)).toEqual(NO_CHANGES);
  expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
    location: "state-db",
  });
});

it("preserves effective main and private-agent auth across relocation", async () => {
  const fixture = await createFixture();
  const effective = () =>
    [fixture.mainAgentDir, fixture.opsAgentDir].map((agentDir) => {
      const { profiles, order, lastGood } = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      return { profiles, order, lastGood };
    });
  const before = effective();
  expect(await fixture.migrate(fixture.detect())).toMatchObject({
    warnings: [],
    changes: [expect.stringContaining("Relocated shared auth")],
  });
  expect(effective()).toEqual(before);
});

it.each(["custom", "main override"] as const)(
  "relocates the configured inheritance owner through Doctor (%s)",
  async (layout) => {
    const fixture = await createEmptyFixture(false);
    const ownerDir = path.join(fixture.stateDir, "custom-owner");
    const peerDir = path.join(fixture.stateDir, "agents/dev/agent");
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { authInheritance: { agentId: "ops" } },
        entries: { ops: { agentDir: ownerDir }, dev: {} },
      },
    };
    if (layout === "main override") {
      fixture.env.OPENCLAW_AGENT_DIR = path.join(fixture.stateDir, "relocated-main");
    }
    const inherited = makeStore("openai:owner", "synthetic-owner-key");
    const privateStore = makeStore("openai:private", "synthetic-private-key");
    resolveAgentDir(config, "ops", fixture.env);
    sqlite.writePersistedAuthProfileStoreRaw(inherited, ownerDir);
    sqlite.writePersistedAuthProfileStoreRaw(privateStore, peerDir);
    const detected = await detectLegacy(fixture.env, undefined, config);

    expect(await fixture.migrate(detected.sharedAuthStore, fixture.env)).toMatchObject({
      warnings: [],
    });
    expect(sharedAuth(fixture.env).store).toEqual(inherited);
    expect(localAuth(ownerDir).store).toBeNull();
    expect(localAuth(peerDir).store).toEqual(privateStore);
    expect(loadAuthProfileStoreWithoutExternalProfiles(peerDir).profiles).toEqual({
      ...inherited.profiles,
      ...privateStore.profiles,
    });
    const db = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
    expect(
      rows(
        db,
        "SELECT DISTINCT source_path FROM migration_sources WHERE migration_kind = 'shared-auth-store-state-db'",
      ),
    ).toEqual([{ source_path: path.join(ownerDir, "openclaw-agent.sqlite") }]);
    expect((await detectLegacy(fixture.env, undefined, config)).sharedAuthStore.hasLegacy).toBe(
      false,
    );
  },
);

it("keeps both credential stores when the configured owner and main are populated", async () => {
  const fixture = await createFixture();
  const detected = await detectLegacy(fixture.env, undefined, {
    agents: { defaults: { authInheritance: { agentId: "ops" } }, entries: { ops: {} } },
  });
  const before = [localAuth(fixture.mainAgentDir), localAuth(fixture.opsAgentDir)];

  expect(await fixture.migrate(detected.sharedAuthStore, fixture.env)).toMatchObject({
    changes: [],
    outcome: "skipped",
    warningDisposition: "recoverable",
    warnings: [expect.stringContaining("also stores credentials")],
  });
  expect([localAuth(fixture.mainAgentDir), localAuth(fixture.opsAgentDir)]).toEqual(before);
  expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
    location: "legacy-main",
  });
});

it.each(["empty owner", "directory alias"] as const)(
  "preserves main-source relocation with a configured %s",
  async (scenario) => {
    const fixture = await createEmptyFixture(false);
    const mainDir = path.dirname(fixture.sourcePath);
    const ownerDir = path.join(fixture.stateDir, "ops-alias");
    const store = makeStore("openai:shared", "synthetic-main-key");
    sqlite.writePersistedAuthProfileStoreRaw(store, mainDir);
    if (scenario === "directory alias") {
      fs.symlinkSync(mainDir, ownerDir, process.platform === "win32" ? "junction" : "dir");
    }
    const detected = await detectLegacy(fixture.env, undefined, {
      agents: {
        defaults: { authInheritance: { agentId: "ops" } },
        entries: { ops: { agentDir: ownerDir } },
      },
    });

    expect(await fixture.migrate(detected.sharedAuthStore, fixture.env)).toMatchObject({
      warnings: [],
    });
    expect(sharedAuth(fixture.env).store).toEqual(store);
    expect(localAuth(mainDir).store).toBeNull();
  },
);

it.each(["order state", "credential override"] as const)(
  "preserves post-relocation main-agent %s without treating it as legacy",
  async (scenario) => {
    const fixture = await createEmptyFixture(false);
    const mainAgentDir = path.dirname(fixture.sourcePath);
    const profileId = "openai:shared";
    await upsertAuthProfileWithLockOrThrow({
      profileId,
      stateDir: fixture.stateDir,
      credential:
        scenario === "order state"
          ? {
              type: "api_key",
              provider: "openai",
              keyRef: { source: "env", provider: "default", id: "OPENCLAW_SHARED_AUTH_TEST_KEY" },
            }
          : { type: "api_key", provider: "openai", key: "shared-key" },
    });
    if (scenario === "order state") {
      await setAuthProfileOrder({
        agentDir: mainAgentDir,
        provider: "openai",
        order: [profileId],
      });
      expect(localAuth(mainAgentDir)).toEqual({
        store: { version: 1, profiles: {} },
        state: { version: 1, order: { openai: [profileId] } },
      });
    } else {
      saveAuthProfileStore(makeStore(profileId, "local-override-key"), mainAgentDir, {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      });
      expect(localAuth(mainAgentDir).store).toEqual(makeStore(profileId, "local-override-key"));
      expect(sharedAuth(fixture.env).store).toEqual(makeStore(profileId, "shared-key"));
    }
    const localBefore = localAuth(mainAgentDir);
    const sharedBefore = sharedAuth(fixture.env);
    const detected = fixture.detect({ env: fixture.env });
    expect(detected).toEqual({ sourcePath: fixture.sourcePath, hasLegacy: false });
    expect(await fixture.migrate(detected, fixture.env)).toEqual(NO_CHANGES);
    expect({ local: localAuth(mainAgentDir), shared: sharedAuth(fixture.env) }).toEqual({
      local: localBefore,
      shared: sharedBefore,
    });
  },
);

const STATE_CONFLICT = "auth_profile_state[primary] -> config_machine_state[authProfiles.state]";
it.each([
  ["older subset", null],
  ["empty subset", null],
  ["changed credential", '"openai:shared": credential differs'],
  ["source-only profile", '"openai:shared": missing from target'],
  ["malformed source", '"bad": malformed credential'],
  ["malformed target", "invalid credential payload"],
  ["malformed target profile", '"bad": malformed credential'],
  ["changed metadata", "store metadata differs"],
  ["changed state", STATE_CONFLICT],
] as const)("verifies a richer target against a %s before cleanup", async (scenario, conflict) => {
  const fixture = await createFixture();
  const sourcePath = sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
  using source = new DatabaseSync(sourcePath);
  const target = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
  const sourceStore =
    scenario === "empty subset" ? { version: 1, profiles: {} } : fixture.sharedStore;
  const escapedProfileId = 'a"\nprofile';
  if (scenario === "changed credential") {
    Object.assign(sourceStore.profiles, makeStore(escapedProfileId, "shared-key").profiles);
  }
  const sourceJson =
    scenario === "malformed source"
      ? '{"version":1,"profiles":{"bad":null}}'
      : JSON.stringify(sourceStore);
  source
    .prepare(
      "UPDATE auth_profile_store SET store_json = ?, updated_at = 100 WHERE store_key = 'primary'",
    )
    .run(sourceJson);
  const sourceRow = readSource(source, "store");
  const stateRow = readSource(source, "state") as { state_json: string; updated_at: number };
  const targetStore = {
    profiles: {
      ...makeStore("openai:extra", "extra-key").profiles,
      ...(scenario === "malformed target profile" ? { bad: null } : {}),
      ...(scenario === "source-only profile"
        ? {}
        : makeStore(
            "openai:shared",
            scenario === "changed credential" ? "different-key" : "shared-key",
          ).profiles),
    },
    version: 1,
    ...(scenario === "changed metadata" ? { legacyMetadata: "keep" } : {}),
  };
  const targetRow = {
    value_json:
      scenario === "malformed target"
        ? '{"version":1,"profiles":null}'
        : JSON.stringify(targetStore),
    updated_at_ms: 200,
  };
  putMachine(target, "authProfiles.store", targetRow.value_json, targetRow.updated_at_ms);
  putMachine(
    target,
    "authProfiles.state",
    stateRow.state_json,
    stateRow.updated_at + Number(["changed state", "changed credential"].includes(scenario)),
  );

  const detected = fixture.detect();
  const result = await fixture.migrate(detected);
  const migratedTarget = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
  const converges = scenario.endsWith("subset");
  expect(result.warnings).toEqual(converges ? [] : [expect.stringMatching(/conflict.*Back up/)]);
  if (!converges) {
    expect(result.warnings[0]).toContain(conflict);
    expect(result.warnings[0]).not.toMatch(/shared-key|extra-key|different-key|legacyMetadata/);
  }
  expect(machineRow(migratedTarget, "authProfiles.store", true)).toEqual(targetRow);
  expect(readSource(source, "store")).toEqual(converges ? undefined : sourceRow);
  expect(readSource(source, "state")).toEqual(converges ? undefined : stateRow);
  expect(receiptRow(migratedTarget)).toEqual(converges ? completedReceipt(sourceRow) : undefined);
  expect(fixture.detect().hasLegacy).toBe(!converges);
  if (scenario === "changed credential") {
    const warning = result.warnings[0]!;
    for (const guidance of [
      "openclaw doctor --fix",
      sourcePath,
      path.join(fixture.stateDir, "state", "openclaw.sqlite"),
    ]) {
      expect(warning).toContain(guidance);
    }
    expect(warning).toContain(`${JSON.stringify(escapedProfileId)}: missing from target`);
    expect(warning.indexOf(JSON.stringify(escapedProfileId))).toBeLessThan(
      warning.indexOf('"openai:shared"'),
    );
    expect(warning).toContain(STATE_CONFLICT);
    expect(warning).not.toContain("\n");
    // Follow the diagnostic: retain target-only profiles and reconcile both conflicting rows.
    const reconciled = {
      ...targetStore,
      profiles: { ...targetStore.profiles, ...sourceStore.profiles },
    };
    updateMachine(migratedTarget, "authProfiles.store", JSON.stringify(reconciled), 200);
    updateMachine(migratedTarget, "authProfiles.state", stateRow.state_json, stateRow.updated_at);
    expect(await fixture.migrate(detected)).toMatchObject({
      warnings: [],
      changes: [expect.stringContaining("Relocated shared auth")],
    });
    expect(sharedAuth(fixture.env).store).toEqual(reconciled);
    expect(fixture.detect().hasLegacy).toBe(false);
  }
});

it.each(["absolute", "tilde"] as const)(
  "detects and relocates only the selected env's %s shared auth source",
  (pathStyle) =>
    (ownerFixtureRun = (async () => {
      const createOwner = async (label: string, lastUsed: number) => {
        const owner = await createOpenClawTestState({
          prefix: "openclaw-shared-auth-source-owner-",
          layout: "split",
          applyEnv: false,
          env: {
            OPENCLAW_AGENT_DIR: undefined,
            PI_CODING_AGENT_DIR: undefined,
            OPENCLAW_OAUTH_DIR: undefined,
            // These auth owners have no plugin inventory; keep discovery inside the fixture.
            OPENCLAW_BUNDLED_PLUGINS_DIR: tempDirs.make("openclaw-shared-auth-bundled-"),
          },
        });
        ownerStates.push(owner);
        const agentDir = path.join(owner.home, "relocated-auth");
        return {
          owner,
          agentDir,
          env: {
            ...owner.env,
            OPENCLAW_AGENT_DIR: pathStyle === "tilde" ? "~/relocated-auth" : agentDir,
          },
          store: makeStore("openai:source", `fake-${label}-${randomUUID()}`),
          state: { version: 1, usageStats: { "openai:source": { lastUsed } } },
        };
      };
      const selected = await createOwner("selected", 20);
      const ambient = await createOwner("ambient", 10);
      ambient.owner.applyEnv();
      vi.stubEnv("OPENCLAW_AGENT_DIR", ambient.env.OPENCLAW_AGENT_DIR);
      for (const source of [selected, ambient]) {
        sqlite.runAuthProfileWriteTransaction(
          source.agentDir,
          (database) => {
            sqlite.writePersistedAuthProfileStoreRaw(source.store, source.agentDir, database);
            sqlite.writePersistedAuthProfileStateRaw(source.state, source.agentDir, database);
          },
          { env: source.env },
        );
      }

      const detected = await detectLegacy(selected.env, () => selected.owner.home);
      expect(detected.stateDir).toBe(selected.owner.stateDir);
      const selectedSourcePath = sqlite.resolveAuthProfileDatabasePath(selected.agentDir);
      expect
        .soft(detected.sharedAuthStore)
        .toEqual({ sourcePath: selectedSourcePath, hasLegacy: true });
      const result = await migration.migrateSharedAuthStore({
        detected: detected.sharedAuthStore,
        stateDir: detected.stateDir,
        env: selected.env,
      });

      expect.soft(result.warnings).toEqual([]);
      expect
        .soft({
          shared: sharedAuth(selected.env),
          selected: localAuth(selected.agentDir),
          ambient: localAuth(ambient.agentDir),
        })
        .toEqual({
          shared: { store: selected.store, state: selected.state },
          selected: { store: null, state: null },
          ambient: { store: ambient.store, state: ambient.state },
        });
      const receipts = rows(
        stateDb.openOpenClawStateDatabase({ env: selected.env }).db,
        "SELECT source_path, status, removed_source FROM migration_sources",
      );
      const receipt = { source_path: selectedSourcePath, status: "completed", removed_source: 1 };
      expect.soft(receipts).toEqual([receipt, receipt]);
    })()),
);

it("defers shared auth inspection while the selected state schema needs repair", async () => {
  const fixture = await createEmptyFixture(false);
  const stateDatabasePath = resolveOpenClawStateSqlitePath(fixture.env);
  fs.mkdirSync(path.dirname(stateDatabasePath), { recursive: true });
  {
    using legacyDatabase = new DatabaseSync(stateDatabasePath);
    legacyDatabase.exec(`
        PRAGMA user_version = 8;
        CREATE TABLE agent_databases (agent_id TEXT NOT NULL, path TEXT NOT NULL,
          schema_version INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
          size_bytes INTEGER, PRIMARY KEY (agent_id, path));
        INSERT INTO agent_databases VALUES ('main', 'agent.sqlite', 1, 10, 20);
      `);
  }
  const stateBytes = fs.readFileSync(stateDatabasePath);
  const sourceBytes = "not a SQLite database";
  fs.mkdirSync(path.dirname(fixture.sourcePath), { recursive: true });
  fs.writeFileSync(fixture.sourcePath, sourceBytes);
  const ambientStateDir = tempDirs.make("openclaw-shared-auth-pending-ambient-");
  vi.stubEnv("OPENCLAW_STATE_DIR", ambientStateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", path.join(ambientStateDir, "relocated-auth"));

  const detected = await detectLegacy(fixture.env);

  expect(detected).toMatchObject({
    stateDir: fixture.stateDir,
    stateSchema: { hasLegacy: true },
  });
  expect(detected.sharedAuthStore).toEqual({ sourcePath: fixture.sourcePath, hasLegacy: false });
  expect(fs.readFileSync(fixture.sourcePath, "utf8")).toBe(sourceBytes);
  expect(fs.readFileSync(stateDatabasePath)).toEqual(stateBytes);
  expect(fs.existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
});

for (const crashState of [
  "copied-not-flipped",
  "copied-source-empty-not-flipped",
  "flipped-not-cleaned",
  "flipped-cleaned-not-finalized",
] as const) {
  it(`converges after the ${crashState} stage boundary`, async () => {
    const fixture = await createFixture();
    const sourcePath = sqlite.resolveAuthProfileDatabasePath(fixture.mainAgentDir);
    const source = new DatabaseSync(sourcePath);
    const store = readSource(source, "store") as { store_json: string; updated_at: number };
    const state = readSource(source, "state") as { state_json: string; updated_at: number };
    const target = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;
    const targetStoreJson =
      crashState === "flipped-cleaned-not-finalized"
        ? JSON.stringify({
            ...fixture.sharedStore,
            profiles: {
              ...fixture.sharedStore.profiles,
              ...makeStore("openai:extra", "extra-key").profiles,
            },
          })
        : store.store_json;
    putMachine(target, "authProfiles.store", targetStoreJson, store.updated_at);
    putMachine(target, "authProfiles.state", state.state_json, state.updated_at);
    const sourceCleaned = crashState.includes("source-empty") || crashState.includes("cleaned-not");
    if (sourceCleaned) {
      source.prepare("DELETE FROM auth_profile_store WHERE store_key = 'primary'").run();
      source.prepare("DELETE FROM auth_profile_state WHERE state_key = 'primary'").run();
    }
    source.close();
    if (crashState.startsWith("flipped")) {
      putMachine(target, "auth.sharedStore", JSON.stringify({ location: "state-db" }), 1);
      ownership.noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, fixture.env);
      const runId = "test-shared-auth-pending-cleanup";
      const sourceKey = `shared-auth-store:${createHash("sha256")
        .update(`${path.resolve(sourcePath)}\0auth_profile_store`)
        .digest("hex")}`;
      target
        .prepare(
          `INSERT INTO migration_runs (id, started_at, finished_at, status, report_json) VALUES (?, 1, NULL, 'ownership-flipped', '{}')`,
        )
        .run(runId);
      target
        .prepare(`INSERT INTO migration_sources (source_key, migration_kind, source_path,
               target_table, source_sha256, source_size_bytes, source_record_count, last_run_id,
               status, imported_at, removed_source, report_json)
             VALUES (?, 'shared-auth-store-state-db', ?, 'auth_profile_stores', ?, NULL, 1, ?, 'ownership-flipped', 1, 0, '{}')`)
        .run(
          sourceKey,
          sourcePath,
          createHash("sha256").update(JSON.stringify(store)).digest("hex"),
          runId,
        );
    }

    const detected = fixture.detect();
    const first = await fixture.migrate(detected);
    const retryDetected = fixture.detect();
    const retry = await fixture.migrate(retryDetected);
    const migratedTarget = stateDb.openOpenClawStateDatabase({ env: fixture.env }).db;

    expect(first.warnings).toEqual([]);
    expect(retryDetected).toMatchObject({ hasLegacy: false });
    expect(ownership.resolveSharedAuthStoreOwnership(fixture.env)).toEqual({
      location: "state-db",
    });
    expect(retry).toEqual(NO_CHANGES);
    if (crashState === "flipped-cleaned-not-finalized") {
      expect(receiptRow(migratedTarget)).toEqual(completedReceipt(store));
      expect(machineRow(migratedTarget, "authProfiles.store")).toEqual({
        value_json: targetStoreJson,
      });
    }
    expect(sharedAuth(fixture.env)).toEqual({
      store: JSON.parse(targetStoreJson),
      state: fixture.sharedState,
    });
    using cleanedSource = new DatabaseSync(sourcePath, { readOnly: true });
    expect([readSource(cleanedSource, "store"), readSource(cleanedSource, "state")]).toEqual([
      undefined,
      undefined,
    ]);
  });
}

it.each(["dangling symlink", "unreadable file"] as const)(
  "fails closed for a legacy source with a %s",
  async (scenario) => {
    const fixture = await createFixture();
    const sourcePath = fixture.sourcePath;
    if (scenario === "dangling symlink") {
      closeOpenClawAgentDatabasesForTest();
      fs.unlinkSync(sourcePath);
      fs.symlinkSync(`${sourcePath}.missing`, sourcePath);
    } else {
      const realLstat = fs.lstatSync;
      vi.spyOn(fs, "lstatSync").mockImplementation((pathname, options) => {
        if (path.resolve(String(pathname)) === path.resolve(sourcePath)) {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        }
        return realLstat(pathname, options as never);
      });
      expect(fixture.detect({ doctorOnlyStateMigrations: false })).toEqual({
        sourcePath,
        hasLegacy: false,
      });
    }
    expect(() => fixture.detect()).toThrowError(
      expect.objectContaining({
        name: "SharedAuthStoreSourceInspectionError",
        code: "SHARED_AUTH_STORE_SOURCE_UNREADABLE",
        sourcePath,
        ...(scenario === "dangling symlink" ? { action: "openclaw doctor --fix" } : {}),
      }),
    );
    expect(
      machineRow(stateDb.openOpenClawStateDatabase({ env: fixture.env }).db, "auth.sharedStore"),
    ).toBeUndefined();
  },
);
