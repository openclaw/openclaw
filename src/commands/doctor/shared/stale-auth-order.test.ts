import "../../../agents/auth-profiles/external-auth.test-support.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthHealthSummary } from "../../../agents/auth-health.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../../agents/auth-profiles/credential-fixtures.test-support.js";
import { resolveAuthProfileOrder } from "../../../agents/auth-profiles/order.js";
import {
  resolveAuthProfileDatabasePath,
  resolveAuthProfileDatabaseFilePaths,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../../agents/auth-profiles/sqlite.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../../../test-utils/database-cleanup.js";
import { captureEnv } from "../../../test-utils/env.js";
import {
  resolveLegacyAuthProfilesPath as resolveAuthStorePath,
  resolveLegacyFlatAuthPath as resolveLegacyAuthStorePath,
} from "../../doctor-auth-legacy-paths.js";
import {
  collectStaleConfiguredAuthOrderWarnings,
  maybeRepairStaleConfiguredAuthOrders,
} from "./stale-auth-order.js";

const { testing: externalAuthTesting } =
  await import("../../../agents/auth-profiles/external-auth.test-support.js");

const pluginMetadataMocks = vi.hoisted(() => {
  const snapshot = {
    plugins: [
      {
        id: "anthropic",
        origin: "bundled",
        providerAuthChoices: [
          {
            provider: "anthropic",
            method: "cli",
            choiceId: "anthropic-cli",
            deprecatedChoiceIds: ["claude-cli"],
          },
        ],
      },
    ],
    diagnostics: [],
  };
  return {
    getCurrentPluginMetadataSnapshot: vi.fn(() => snapshot),
    loadPluginMetadataSnapshot: vi.fn(() => snapshot),
  };
});

vi.mock("../../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../plugins/current-plugin-metadata-snapshot.js")
  >()),
  getCurrentPluginMetadataSnapshot: pluginMetadataMocks.getCurrentPluginMetadataSnapshot,
}));

vi.mock("../../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginMetadataMocks.loadPluginMetadataSnapshot,
}));

function tokenStore(profileId: string, provider = "claude-cli"): AuthProfileStore {
  return createAuthProfileStoreFixture({
    [profileId]: {
      type: "token",
      provider,
      token: "setup-token",
    },
  });
}

function writeTokenStore(agentDir: string, profileId: string, provider?: string): void {
  writePersistedAuthProfileStoreRaw(tokenStore(profileId, provider), agentDir);
}

function writeMainToken(stateDir: string): void {
  writeTokenStore(path.join(stateDir, "agents", "main", "agent"), "claude-cli:main-token");
}

function repairPersisted(cfg: OpenClawConfig, stateDir: string) {
  return maybeRepairStaleConfiguredAuthOrders({ cfg, env: { OPENCLAW_STATE_DIR: stateDir } });
}

function expectUnchanged(result: ReturnType<typeof repairPersisted>, cfg: OpenClawConfig): void {
  expect(result.config).toBe(cfg);
  expect(result.changes).toEqual([]);
}

function closeAuthDatabases(): void {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

function registeredStore(
  stateDir: string,
  state?: Parameters<typeof writePersistedAuthProfileStateRaw>[0],
) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  writeMainToken(stateDir);
  const customAgentDir = path.join(stateDir, "custom-agents", "retained");
  const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
  const database = openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
  if (state) {
    writePersistedAuthProfileStateRaw(state, customAgentDir, database);
  }
  closeAuthDatabases();
  return { env, customAgentDir, databasePath };
}

function writeOtherAgentStore(agentDir: string, env: NodeJS.ProcessEnv) {
  const database = openOpenClawAgentDatabase({
    agentId: "other",
    env,
    path: resolveAuthProfileDatabasePath(agentDir),
  });
  writePersistedAuthProfileStoreRaw(tokenStore("anthropic:other", "anthropic"), agentDir, database);
  closeAuthDatabases();
}

function declaredOrderConfig(ambiguous = false): OpenClawConfig {
  return {
    memory: {},
    auth: {
      profiles: {
        "openai:chatgpt-manual": { provider: "openai", mode: "oauth" },
        ...(ambiguous
          ? { "openai:api-manual": { provider: "openai", mode: "api_key" as const } }
          : {}),
      },
      order: { openai: ["openai:manual"] },
    },
  };
}

function mutateDatabase(databasePath: string, mutate: (db: DatabaseSync) => void) {
  const database = new DatabaseSync(databasePath);
  try {
    mutate(database);
  } finally {
    database.close();
  }
}

function anthropicOrderConfig(
  profileId: string,
  entries?: NonNullable<OpenClawConfig["agents"]>["entries"],
): OpenClawConfig {
  return {
    ...(entries ? { agents: { entries } } : {}),
    auth: { order: { anthropic: [profileId] } },
  };
}

describe("maybeRepairStaleConfiguredAuthOrders", () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
  let stateDir = "";
  let workAgentDir = "";
  let env: NodeJS.ProcessEnv;
  function warnings(cfg: OpenClawConfig, environment?: NodeJS.ProcessEnv) {
    return collectStaleConfiguredAuthOrderWarnings({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
      env: environment,
    });
  }
  function expectBlocked(
    cfg: OpenClawConfig,
    warning = "Skipped auth.order repair",
    environment = env,
  ) {
    const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env: environment });
    expectUnchanged(result, cfg);
    expect(result.warnings?.join("\n")).toContain(warning);
  }
  function expectRepaired(cfg: OpenClawConfig, environment = env) {
    const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env: environment });
    expect(result.config.auth?.order?.anthropic).toBeUndefined();
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toBeUndefined();
  }
  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-stale-auth-order-"));
    env = { OPENCLAW_STATE_DIR: stateDir };
    workAgentDir = path.join(stateDir, "agents", "work", "agent");
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
    clearPluginMetadataLifecycleCaches();
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(async () => {
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
    closeAuthDatabases();
    envSnapshot.restore();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("repairs an undeclared order id to the only declared profile for that provider", async () => {
    const cfg = declaredOrderConfig();

    const result = repairPersisted(cfg, stateDir);
    expect(result.config.auth?.order?.openai).toEqual(["openai:chatgpt-manual"]);
    expect(result.changes).toEqual([
      "auth.order.openai: replaced undeclared openai:manual with openai:chatgpt-manual.",
    ]);
  });

  it("reports an undeclared order id without changing ambiguous provider profiles", async () => {
    const cfg = declaredOrderConfig(true);

    const preview = warnings(cfg, env);
    const result = repairPersisted(cfg, stateDir);
    expectUnchanged(result, cfg);
    expect(preview.join("\n")).toContain(
      "declared profiles for this provider are ambiguous (openai:chatgpt-manual, openai:api-manual)",
    );
    expect(result.warnings?.join("\n")).toContain("Set auth.order.openai explicitly");
  });

  it("preserves an explicit empty order", () => {
    const cfg = { auth: { order: { anthropic: [] } } } satisfies OpenClawConfig;

    const result = maybeRepairStaleConfiguredAuthOrders({ cfg });
    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("leaves malformed auth-order entries to config validation", () => {
    const cfg = {
      auth: { order: { anthropic: "anthropic:missing" } },
    } as unknown as OpenClawConfig;

    expect(maybeRepairStaleConfiguredAuthOrders({ cfg })).toEqual({ config: cfg, changes: [] });
    expect(warnings(cfg)).toEqual([]);
  });

  it("leaves malformed auth profile metadata to config validation", () => {
    const cfg = {
      auth: {
        profiles: { broken: null },
        order: { anthropic: ["anthropic:missing"] },
      },
    } as unknown as OpenClawConfig;

    expect(maybeRepairStaleConfiguredAuthOrders({ cfg })).toEqual({ config: cfg, changes: [] });
    expect(warnings(cfg)).toEqual([]);
  });

  it("does not use a registered inactive store as the automatic fallback proof", async () => {
    const customAgentDir = path.join(stateDir, "custom-agents", "retained");
    const database = openOpenClawAgentDatabase({
      agentId: "retained",
      env,
      path: resolveAuthProfileDatabasePath(customAgentDir),
    });
    writePersistedAuthProfileStoreRaw(
      tokenStore("claude-cli:inactive-token"),
      customAgentDir,
      database,
    );
    closeAuthDatabases();
    const cfg = anthropicOrderConfig("anthropic:missing", { main: {} });

    const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });
    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("does not repair while a registered custom agent has an unmigrated auth store", async () => {
    const { customAgentDir } = registeredStore(stateDir);
    await fs.writeFile(
      resolveAuthStorePath(customAgentDir),
      JSON.stringify(tokenStore("anthropic:legacy", "anthropic")),
    );
    const cfg = anthropicOrderConfig("anthropic:missing", { main: {} });

    const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });
    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling retained-agent symlink",
    async () => {
      writeMainToken(stateDir);
      const retainedRoot = path.join(stateDir, "agents", "retained");
      await fs.mkdir(retainedRoot, { recursive: true });
      await fs.symlink(
        path.join(stateDir, "missing-agent"),
        path.join(retainedRoot, "agent"),
        "dir",
      );
      expectBlocked(anthropicOrderConfig("anthropic:missing"), "unavailable");
    },
  );

  it("preserves profiles in the PI_CODING_AGENT_DIR-selected auth store", async () => {
    const selectedAgentDir = path.join(stateDir, "selected-agent");
    writeTokenStore(selectedAgentDir, "claude-cli:selected-token");
    writeMainToken(stateDir);
    const cfg = anthropicOrderConfig("claude-cli:selected-token");

    const result = maybeRepairStaleConfiguredAuthOrders({
      cfg,
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        PI_CODING_AGENT_DIR: selectedAgentDir,
      },
    });

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("uses OPENCLAW_AGENT_DIR as the inherited shared-main auth store", async () => {
    const sharedMainAgentDir = path.join(stateDir, "relocated-main-agent");
    writeTokenStore(sharedMainAgentDir, "anthropic:relocated-main", "anthropic");
    const cfg = anthropicOrderConfig("anthropic:missing");

    const result = maybeRepairStaleConfiguredAuthOrders({
      cfg,
      env: {
        OPENCLAW_AGENT_DIR: sharedMainAgentDir,
        OPENCLAW_STATE_DIR: stateDir,
      },
    });

    expect(result.config.auth?.order?.anthropic).toBeUndefined();
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toBeUndefined();
  });

  it("preserves an order that selects a runtime-only external profile", async () => {
    const cfg = {
      agents: { entries: { work: {} } },
      auth: { order: { openai: ["openai:runtime-only"] } },
    } satisfies OpenClawConfig;
    writePersistedAuthProfileStoreRaw(
      createAuthProfileStoreFixture({
        "openai:main-seed": createApiKeyCredential("openai", "api-key"),
      }),
      path.join(stateDir, "agents", "main", "agent"),
    );
    externalAuthTesting.setResolveExternalAuthProfilesForTest((params) =>
      params.context.agentDir === workAgentDir && params.context.store.profiles["openai:main-seed"]
        ? [
            {
              profileId: "openai:runtime-only",
              credential: {
                type: "oauth",
                provider: "openai",
                access: "access",
                refresh: "refresh",
                expires: Date.now() + 60_000,
              },
              persistence: "runtime-only",
            },
          ]
        : [],
    );

    const result = repairPersisted(cfg, stateDir);
    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("warns and does not repair when an active auth database is unreadable", async () => {
    writeMainToken(stateDir);
    await fs.mkdir(workAgentDir, { recursive: true });
    await fs.writeFile(resolveAuthProfileDatabasePath(workAgentDir), "not-a-sqlite-database");
    const cfg = anthropicOrderConfig("anthropic:missing", { work: {} });
    expectBlocked(cfg);
    expect(warnings(cfg, env).join("\n")).toContain("SQLite auth profile store is unreadable");
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling active auth database symlink",
    async () => {
      writeMainToken(stateDir);
      await fs.mkdir(workAgentDir, { recursive: true });
      await fs.symlink(
        path.join(workAgentDir, "missing.sqlite"),
        resolveAuthProfileDatabasePath(workAgentDir),
      );
      expectBlocked(anthropicOrderConfig("anthropic:missing", { work: {} }), "unavailable");
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling legacy auth source beside a legacy database",
    async () => {
      writeMainToken(stateDir);
      await fs.mkdir(workAgentDir, { recursive: true });
      const legacyDatabase = new DatabaseSync(resolveAuthProfileDatabasePath(workAgentDir));
      legacyDatabase.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
      legacyDatabase.close();
      await fs.symlink(
        path.join(workAgentDir, "missing-auth-profiles.json"),
        resolveAuthStorePath(workAgentDir),
      );
      expectBlocked(anthropicOrderConfig("anthropic:missing", { work: {} }), "unavailable");
    },
  );

  it("fails closed when a registered custom auth database is unreadable", async () => {
    const { databasePath } = registeredStore(stateDir);
    await fs.writeFile(databasePath, "not-sqlite");
    expectBlocked(anthropicOrderConfig("anthropic:missing"));
  });

  it("fails closed when registered auth runtime state is unreadable without a secrets row", async () => {
    const { databasePath } = registeredStore(stateDir, {
      version: 1,
      order: { anthropic: ["anthropic:retained"] },
    });
    mutateDatabase(databasePath, (db) =>
      db
        .prepare("UPDATE auth_profile_state SET state_json = ? WHERE state_key = ?")
        .run("{", "primary"),
    );
    expectBlocked(anthropicOrderConfig("anthropic:missing"), "unreadable");
  });

  it("fails closed when a registered auth database owner no longer matches", async () => {
    const { databasePath } = registeredStore(stateDir);
    mutateDatabase(databasePath, (db) =>
      db
        .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = ?")
        .run("replacement", "primary"),
    );
    expectBlocked(anthropicOrderConfig("anthropic:missing"));
  });

  it("uses the live owner after a registered database pathname is recreated", async () => {
    writeMainToken(stateDir);
    const customAgentDir = path.join(stateDir, "custom-agents", "retained");
    const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
    openOpenClawAgentDatabase({ agentId: "retired", env, path: databasePath });
    closeOpenClawAgentDatabasesForTest();
    for (const pathname of resolveAuthProfileDatabaseFilePaths(customAgentDir)) {
      await fs.rm(pathname, { force: true });
    }
    openOpenClawAgentDatabase({ agentId: "replacement", env, path: databasePath });
    closeAuthDatabases();
    expectRepaired(anthropicOrderConfig("anthropic:missing", { main: {} }));
  });

  it("fails closed when an active agent points at another agent's database", async () => {
    writeMainToken(stateDir);
    const customAgentDir = path.join(stateDir, "custom-agents", "shared");
    writeOtherAgentStore(customAgentDir, env);
    expectBlocked(
      anthropicOrderConfig("anthropic:missing", { work: { agentDir: customAgentDir } }),
    );
  });

  it("fails closed when an ownerless active database contains auth tables", async () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    await fs.mkdir(agentDir, { recursive: true });
    const rawDatabase = new DatabaseSync(databasePath);
    rawDatabase.exec(`
        CREATE TABLE auth_profile_store (
          store_key TEXT PRIMARY KEY NOT NULL,
          store_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE auth_profile_state (
          state_key TEXT PRIMARY KEY NOT NULL,
          state_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    rawDatabase
      .prepare(
        "INSERT INTO auth_profile_store (store_key, store_json, updated_at) VALUES (?, ?, ?)",
      )
      .run("primary", JSON.stringify(tokenStore("claude-cli:setup-token")), Date.now());
    rawDatabase.close();
    expectBlocked(anthropicOrderConfig("anthropic:missing"));
  });

  it("fails closed when an environment-selected directory belongs to another agent", async () => {
    const envAgentDir = path.join(stateDir, "custom-env-agent");
    const selectedEnv = { ...env, OPENCLAW_AGENT_DIR: envAgentDir };
    writeMainToken(stateDir);
    writeOtherAgentStore(envAgentDir, selectedEnv);
    const cfg = anthropicOrderConfig("anthropic:missing");

    expectBlocked(cfg, "Skipped auth.order repair", selectedEnv);
  });

  it("restores alias-group selection only while every active auth database is complete", async () => {
    const mainStore: AuthProfileStore = createAuthProfileStoreFixture({
      "anthropic:oauth": {
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      },
    });
    const childStore = tokenStore("claude-cli:token");
    writePersistedAuthProfileStoreRaw(mainStore, path.join(stateDir, "agents", "main", "agent"));
    writePersistedAuthProfileStoreRaw(childStore, workAgentDir);
    const cfg = {
      agents: { entries: { main: {}, work: {} } },
      auth: {
        order: {
          anthropic: ["anthropic:removed"],
          "claude-cli": ["claude-cli:removed"],
        },
      },
    } satisfies OpenClawConfig;
    const before = buildAuthHealthSummary({ cfg, store: childStore });
    const repaired = repairPersisted(cfg, stateDir);
    const after = buildAuthHealthSummary({ cfg: repaired.config, store: childStore });

    expect(before.providers).toEqual([
      expect.objectContaining({
        provider: "claude-cli",
        status: "missing",
        effectiveProfiles: [],
      }),
    ]);
    expect(repaired.config.auth?.order).toEqual({});
    expect(after.providers).toEqual([
      expect.objectContaining({
        provider: "claude-cli",
        status: "ok",
        effectiveProfiles: [expect.objectContaining({ profileId: "claude-cli:token" })],
      }),
    ]);
    expect(
      resolveAuthProfileOrder({ cfg: repaired.config, store: mainStore, provider: "anthropic" }),
    ).toEqual(["anthropic:oauth"]);
    expect(
      resolveAuthProfileOrder({
        cfg: repaired.config,
        store: childStore,
        provider: "claude-cli",
      }),
    ).toEqual(["claude-cli:token"]);

    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    const rawDatabase = new DatabaseSync(resolveAuthProfileDatabasePath(workAgentDir));
    rawDatabase.exec("DROP TABLE auth_profile_state;");
    rawDatabase.close();

    expectBlocked(cfg);
  });

  it("fails closed when a stale registered database leaves a SQLite sidecar", async () => {
    const { customAgentDir, databasePath } = registeredStore(stateDir);
    await fs.rm(databasePath);
    const [, walPath] = resolveAuthProfileDatabaseFilePaths(customAgentDir);
    if (!walPath) {
      throw new Error("expected SQLite WAL path");
    }
    await fs.writeFile(walPath, "orphaned-wal");
    expectBlocked(anthropicOrderConfig("anthropic:missing"), "unavailable");
  });

  it("ignores a stale registered auth database after its pathname is removed", async () => {
    const { databasePath } = registeredStore(stateDir);
    await fs.rm(databasePath);
    expectRepaired(anthropicOrderConfig("anthropic:missing", { main: {} }));
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling registered auth database parent symlink",
    async () => {
      writeMainToken(stateDir);
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const originalAgentDir = path.join(stateDir, "custom-agent-target");
      await fs.mkdir(originalAgentDir, { recursive: true });
      await fs.mkdir(path.dirname(customAgentDir), { recursive: true });
      await fs.symlink(originalAgentDir, customAgentDir, "dir");
      openOpenClawAgentDatabase({
        agentId: "retained",
        env,
        path: resolveAuthProfileDatabasePath(customAgentDir),
      });
      closeAuthDatabases();
      await fs.rm(customAgentDir);
      await fs.symlink(path.join(stateDir, "missing-agent-target"), customAgentDir, "dir");
      expectBlocked(anthropicOrderConfig("anthropic:missing"), "unavailable");
    },
  );

  it("warns and preserves an ordered profile dropped by store coercion", async () => {
    writePersistedAuthProfileStoreRaw(
      {
        version: 1,
        profiles: {
          "anthropic:old": { type: "invalid", provider: "anthropic" },
          ...tokenStore("claude-cli:setup-token").profiles,
        },
      },
      path.join(stateDir, "agents", "main", "agent"),
    );
    expectBlocked(anthropicOrderConfig("anthropic:old"), "contains invalid credentials");
  });

  it("repairs when an active agent database has no auth-profile row", async () => {
    writePersistedAuthProfileStateRaw({ version: 1 }, workAgentDir);
    writeMainToken(stateDir);
    const cfg = anthropicOrderConfig("anthropic:missing", { work: {} });

    const result = repairPersisted(cfg, stateDir);
    expect(result.config.auth?.order?.anthropic).toBeUndefined();
  });

  it("repairs when an active legacy agent database predates auth tables", async () => {
    const databasePath = resolveAuthProfileDatabasePath(workAgentDir);
    await fs.mkdir(workAgentDir, { recursive: true });
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
    legacyDatabase.close();
    writeMainToken(stateDir);
    const cfg = anthropicOrderConfig("anthropic:missing", { work: {} });

    const result = repairPersisted(cfg, stateDir);
    expect(result.config.auth?.order?.anthropic).toBeUndefined();
  });

  it("does not repair while an invalid legacy auth source remains", async () => {
    await fs.mkdir(workAgentDir, { recursive: true });
    await fs.writeFile(resolveLegacyAuthStorePath(workAgentDir), "not-json", "utf8");
    writeMainToken(stateDir);
    const cfg = anthropicOrderConfig("anthropic:missing", { work: {} });

    const result = repairPersisted(cfg, stateDir);
    expect(result).toEqual({ config: cfg, changes: [] });
  });
});
