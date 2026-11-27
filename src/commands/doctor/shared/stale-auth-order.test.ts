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
  createOAuthRefreshCredential,
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
    [profileId]: { type: "token", provider, token: "setup-token" },
  });
}

function writeTokenStore(agentDir: string, profileId: string, provider?: string): void {
  writePersistedAuthProfileStoreRaw(tokenStore(profileId, provider), agentDir);
}

function writeMainToken(stateDir: string): void {
  writeTokenStore(path.join(stateDir, "agents", "main", "agent"), "claude-cli:main-token");
}

function closeAuthDatabases(): void {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

function registerAuthStore(
  agentDir: string,
  agentId: string,
  env: NodeJS.ProcessEnv,
  store?: AuthProfileStore,
  state?: Parameters<typeof writePersistedAuthProfileStateRaw>[0],
) {
  const databasePath = resolveAuthProfileDatabasePath(agentDir);
  const database = openOpenClawAgentDatabase({ agentId, env, path: databasePath });
  if (store) {
    writePersistedAuthProfileStoreRaw(store, agentDir, database);
  }
  if (state) {
    writePersistedAuthProfileStateRaw(state, agentDir, database);
  }
  closeAuthDatabases();
  return databasePath;
}

function registeredStore(
  stateDir: string,
  state?: Parameters<typeof writePersistedAuthProfileStateRaw>[0],
) {
  writeMainToken(stateDir);
  const customAgentDir = path.join(stateDir, "custom-agents", "retained");
  const databasePath = registerAuthStore(
    customAgentDir,
    "retained",
    { OPENCLAW_STATE_DIR: stateDir },
    undefined,
    state,
  );
  return { customAgentDir, databasePath };
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
  profileId = "anthropic:missing",
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
  const repair = (cfg = anthropicOrderConfig(), environment = env) =>
    maybeRepairStaleConfiguredAuthOrders({ cfg, env: environment });
  const expectNoRepair = (cfg = anthropicOrderConfig(), environment = env) =>
    expect(repair(cfg, environment)).toEqual({ config: cfg, changes: [] });
  function warnings(cfg: OpenClawConfig, environment?: NodeJS.ProcessEnv) {
    return collectStaleConfiguredAuthOrderWarnings({
      cfg,
      doctorFixCommand: "openclaw doctor --fix",
      env: environment,
    });
  }
  function expectBlocked(
    cfg = anthropicOrderConfig(),
    warning = "Skipped auth.order repair",
    environment = env,
  ) {
    const result = repair(cfg, environment);
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(result.warnings?.join("\n")).toContain(warning);
  }
  function expectRepaired(cfg: OpenClawConfig, environment = env) {
    const result = repair(cfg, environment);
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
    const result = repair(declaredOrderConfig());
    expect(result.config.auth?.order?.openai).toEqual(["openai:chatgpt-manual"]);
    expect(result.changes).toHaveLength(1);
  });

  it("reports an undeclared order id without changing ambiguous provider profiles", async () => {
    const cfg = declaredOrderConfig(true);

    const preview = warnings(cfg, env);
    const result = repair(cfg);
    expect(result.config).toBe(cfg);
    expect(result.changes).toEqual([]);
    expect(preview.join("\n")).toContain(
      "declared profiles for this provider are ambiguous (openai:chatgpt-manual, openai:api-manual)",
    );
    expect(result.warnings?.join("\n")).toContain("Set auth.order.openai explicitly");
  });

  it("preserves an explicit empty order", () => {
    expectNoRepair({ auth: { order: { anthropic: [] } } });
  });

  it.each([
    ["auth-order entries", { order: { anthropic: "anthropic:missing" } }],
    [
      "profile metadata",
      { profiles: { broken: null }, order: { anthropic: ["anthropic:missing"] } },
    ],
  ])("leaves malformed %s to config validation", (_name, auth) => {
    const cfg = { auth } as unknown as OpenClawConfig;
    expectNoRepair(cfg);
    expect(warnings(cfg)).toEqual([]);
  });

  it("does not use a registered inactive store as the automatic fallback proof", async () => {
    const customAgentDir = path.join(stateDir, "custom-agents", "retained");
    registerAuthStore(customAgentDir, "retained", env, tokenStore("claude-cli:inactive-token"));
    expectNoRepair(anthropicOrderConfig("anthropic:missing", { main: {} }));
  });

  it("does not repair while a registered custom agent has an unmigrated auth store", async () => {
    const { customAgentDir } = registeredStore(stateDir);
    await fs.writeFile(
      resolveAuthStorePath(customAgentDir),
      JSON.stringify(tokenStore("anthropic:legacy", "anthropic")),
    );
    expectNoRepair(anthropicOrderConfig("anthropic:missing", { main: {} }));
  });

  it
    .skipIf(process.platform === "win32")
    .each([
      "retained-agent directory",
      "active auth database",
      "legacy auth source beside a legacy database",
    ])("fails closed on a dangling %s symlink", async (source) => {
    writeMainToken(stateDir);
    const retained = source === "retained-agent directory";
    const agentDir = retained ? path.join(stateDir, "agents", "retained") : workAgentDir;
    await fs.mkdir(agentDir, { recursive: true });
    if (source === "legacy auth source beside a legacy database") {
      mutateDatabase(resolveAuthProfileDatabasePath(agentDir), (db) => {
        db.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
      });
    }
    await fs.symlink(
      path.join(agentDir, "missing"),
      retained
        ? path.join(agentDir, "agent")
        : source === "active auth database"
          ? resolveAuthProfileDatabasePath(agentDir)
          : resolveAuthStorePath(agentDir),
      retained ? "dir" : "file",
    );
    expectBlocked(
      anthropicOrderConfig("anthropic:missing", retained ? undefined : { work: {} }),
      "unavailable",
    );
  });

  it("preserves profiles in the PI_CODING_AGENT_DIR-selected auth store", async () => {
    const selectedAgentDir = path.join(stateDir, "selected-agent");
    writeTokenStore(selectedAgentDir, "claude-cli:selected-token");
    writeMainToken(stateDir);
    expectNoRepair(anthropicOrderConfig("claude-cli:selected-token"), {
      ...env,
      PI_CODING_AGENT_DIR: selectedAgentDir,
    });
  });

  it("uses OPENCLAW_AGENT_DIR as the inherited shared-main auth store", async () => {
    const sharedMainAgentDir = path.join(stateDir, "relocated-main-agent");
    writeTokenStore(sharedMainAgentDir, "anthropic:relocated-main", "anthropic");
    expectRepaired(anthropicOrderConfig("anthropic:missing"), {
      ...env,
      OPENCLAW_AGENT_DIR: sharedMainAgentDir,
    });
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
              credential: createOAuthRefreshCredential(),
              persistence: "runtime-only",
            },
          ]
        : [],
    );

    expectNoRepair(cfg);
  });

  it("warns and does not repair when an active auth database is unreadable", async () => {
    writeMainToken(stateDir);
    await fs.mkdir(workAgentDir, { recursive: true });
    await fs.writeFile(resolveAuthProfileDatabasePath(workAgentDir), "not-a-sqlite-database");
    const cfg = anthropicOrderConfig("anthropic:missing", { work: {} });
    expectBlocked(cfg);
    expect(warnings(cfg, env).join("\n")).toContain("SQLite auth profile store is unreadable");
  });

  it("fails closed when a registered custom auth database is unreadable", async () => {
    const { databasePath } = registeredStore(stateDir);
    await fs.writeFile(databasePath, "not-sqlite");
    expectBlocked();
  });

  it.each([
    [
      "runtime state unreadable without secrets",
      "auth_profile_state",
      "state_json",
      "state_key",
      "{",
    ],
    ["owner mismatch", "schema_meta", "agent_id", "meta_key", "replacement"],
  ])("fails closed on registered auth %s", (_name, table, column, key, value) => {
    const { databasePath } = registeredStore(stateDir, { version: 1 });
    mutateDatabase(databasePath, (db) =>
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`).run(value, "primary"),
    );
    expectBlocked(undefined, "unreadable");
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
    registerAuthStore(customAgentDir, "other", env, tokenStore("anthropic:other", "anthropic"));
    expectBlocked(
      anthropicOrderConfig("anthropic:missing", { work: { agentDir: customAgentDir } }),
    );
  });

  it("fails closed when an ownerless active database contains auth tables", async () => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const databasePath = resolveAuthProfileDatabasePath(agentDir);
    await fs.mkdir(agentDir, { recursive: true });
    mutateDatabase(databasePath, (db) => {
      db.exec(`
        CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY NOT NULL, store_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE auth_profile_state (state_key TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      `);
      db.prepare("INSERT INTO auth_profile_store VALUES (?, ?, ?)").run(
        "primary",
        JSON.stringify(tokenStore("claude-cli:setup-token")),
        Date.now(),
      );
    });
    expectBlocked();
  });

  it("fails closed when an environment-selected directory belongs to another agent", async () => {
    const envAgentDir = path.join(stateDir, "custom-env-agent");
    const selectedEnv = { ...env, OPENCLAW_AGENT_DIR: envAgentDir };
    writeMainToken(stateDir);
    registerAuthStore(
      envAgentDir,
      "other",
      selectedEnv,
      tokenStore("anthropic:other", "anthropic"),
    );
    const cfg = anthropicOrderConfig("anthropic:missing");

    expectBlocked(cfg, "Skipped auth.order repair", selectedEnv);
  });

  it("restores alias-group selection only while every active auth database is complete", async () => {
    const mainStore: AuthProfileStore = createAuthProfileStoreFixture({
      "anthropic:oauth": createOAuthRefreshCredential({ provider: "anthropic" }),
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
    const repaired = repair(cfg);
    const after = buildAuthHealthSummary({ cfg: repaired.config, store: childStore });

    expect(before.providers).toEqual([
      expect.objectContaining({ provider: "claude-cli", status: "missing", effectiveProfiles: [] }),
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

    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    mutateDatabase(resolveAuthProfileDatabasePath(workAgentDir), (db) =>
      db.exec("DROP TABLE auth_profile_state;"),
    );

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
    expectBlocked(undefined, "unavailable");
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
      registerAuthStore(customAgentDir, "retained", env);
      await fs.rm(customAgentDir);
      await fs.symlink(path.join(stateDir, "missing-agent-target"), customAgentDir, "dir");
      expectBlocked(undefined, "unavailable");
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
    expectRepaired(anthropicOrderConfig("anthropic:missing", { work: {} }));
  });

  it("repairs when an active legacy agent database predates auth tables", async () => {
    const databasePath = resolveAuthProfileDatabasePath(workAgentDir);
    await fs.mkdir(workAgentDir, { recursive: true });
    mutateDatabase(databasePath, (db) =>
      db.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);"),
    );
    writeMainToken(stateDir);
    expectRepaired(anthropicOrderConfig("anthropic:missing", { work: {} }));
  });

  it("does not repair while an invalid legacy auth source remains", async () => {
    await fs.mkdir(workAgentDir, { recursive: true });
    await fs.writeFile(resolveLegacyAuthStorePath(workAgentDir), "not-json", "utf8");
    writeMainToken(stateDir);
    expectNoRepair(anthropicOrderConfig("anthropic:missing", { work: {} }));
  });
});
