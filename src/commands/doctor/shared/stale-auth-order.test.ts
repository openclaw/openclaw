import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthHealthSummary } from "../../../agents/auth-health.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../../agents/auth-profiles/credential-fixtures.test-support.js";
import { testing as externalAuthTesting } from "../../../agents/auth-profiles/external-auth.test-support.js";
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
import {
  resolveLegacyAuthProfilesPath as resolveAuthStorePath,
  resolveLegacyFlatAuthPath as resolveLegacyAuthStorePath,
} from "../../doctor-auth-legacy-paths.js";
import {
  collectStaleConfiguredAuthOrderWarnings,
  maybeRepairStaleConfiguredAuthOrders,
} from "./stale-auth-order.js";
import { repairStaleConfiguredAuthOrders, withStateDir } from "./stale-auth-order.test-support.js";

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

function tokenStore(params: { profileId: string; provider?: string }): AuthProfileStore {
  return createAuthProfileStoreFixture({
    [params.profileId]: {
      type: "token",
      provider: params.provider ?? "claude-cli",
      token: "setup-token",
    },
  });
}

function writeTokenStore(agentDir: string, params: Parameters<typeof tokenStore>[0]): void {
  writePersistedAuthProfileStoreRaw(tokenStore(params), agentDir);
}

function writeMainToken(stateDir: string): void {
  writeTokenStore(path.join(stateDir, "agents", "main", "agent"), {
    profileId: "claude-cli:main-token",
  });
}

function repairPersisted(cfg: OpenClawConfig, stateDir: string) {
  return maybeRepairStaleConfiguredAuthOrders({ cfg, env: { OPENCLAW_STATE_DIR: stateDir } });
}

function closeAuthDatabases(): void {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

function anthropicOrderConfig(
  profileId: string,
  agents?: OpenClawConfig["agents"],
): OpenClawConfig {
  return { ...(agents ? { agents } : {}), auth: { order: { anthropic: [profileId] } } };
}

function repair(cfg: OpenClawConfig, stores: AuthProfileStore[]) {
  return repairStaleConfiguredAuthOrders({ cfg, stores });
}

describe("repairStaleConfiguredAuthOrders", () => {
  beforeEach(() => {
    clearPluginMetadataLifecycleCaches();
    externalAuthTesting.setResolveExternalAuthProfilesForTest(() => []);
  });

  afterEach(() => {
    externalAuthTesting.resetResolveExternalAuthProfilesForTest();
  });

  it("repairs an undeclared order id to the only declared profile for that provider", async () => {
    await withStateDir("openclaw-stale-auth-order-", async (stateDir) => {
      const cfg = {
        memory: {},
        auth: {
          profiles: {
            "openai:chatgpt-manual": { provider: "openai", mode: "oauth" },
          },
          order: { openai: ["openai:manual"] },
        },
      } satisfies OpenClawConfig;

      const result = repairPersisted(cfg, stateDir);

      expect(result.config.auth?.order?.openai).toEqual(["openai:chatgpt-manual"]);
      expect(result.changes).toEqual([
        "auth.order.openai: replaced undeclared openai:manual with openai:chatgpt-manual.",
      ]);
    });
  });

  it("reports an undeclared order id without changing ambiguous provider profiles", async () => {
    await withStateDir("openclaw-stale-auth-order-", async (stateDir) => {
      const cfg = {
        memory: {},
        auth: {
          profiles: {
            "openai:chatgpt-manual": { provider: "openai", mode: "oauth" },
            "openai:api-manual": { provider: "openai", mode: "api_key" },
          },
          order: { openai: ["openai:manual"] },
        },
      } satisfies OpenClawConfig;

      const preview = collectStaleConfiguredAuthOrderWarnings({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
        env: { OPENCLAW_STATE_DIR: stateDir },
      });
      const result = repairPersisted(cfg, stateDir);

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(preview.join("\n")).toContain(
        "declared profiles for this provider are ambiguous (openai:chatgpt-manual, openai:api-manual)",
      );
      expect(result.warnings?.join("\n")).toContain("Set auth.order.openai explicitly");
    });
  });

  it("preserves an explicit empty order", () => {
    const cfg = { auth: { order: { anthropic: [] } } } satisfies OpenClawConfig;

    const result = repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })]);

    expect(result).toEqual({ config: cfg, changes: [] });
  });

  it("leaves malformed auth-order entries to config validation", () => {
    const cfg = {
      auth: { order: { anthropic: "anthropic:missing" } },
    } as unknown as OpenClawConfig;

    expect(repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })])).toEqual({
      config: cfg,
      changes: [],
    });
    expect(
      collectStaleConfiguredAuthOrderWarnings({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([]);
  });

  it("leaves malformed auth profile metadata to config validation", () => {
    const cfg = {
      auth: {
        profiles: { broken: null },
        order: { anthropic: ["anthropic:missing"] },
      },
    } as unknown as OpenClawConfig;

    expect(repair(cfg, [tokenStore({ profileId: "claude-cli:setup-token" })])).toEqual({
      config: cfg,
      changes: [],
    });
    expect(
      collectStaleConfiguredAuthOrderWarnings({
        cfg,
        doctorFixCommand: "openclaw doctor --fix",
      }),
    ).toEqual([]);
  });

  it("removes stale aliases together and restores each agent's automatic selection", () => {
    const cfg = {
      auth: {
        order: {
          anthropic: ["anthropic:removed"],
          "claude-cli": ["claude-cli:removed"],
        },
      },
    } satisfies OpenClawConfig;
    const mainStore: AuthProfileStore = createAuthProfileStoreFixture({
      "anthropic:oauth": {
        type: "oauth",
        provider: "anthropic",
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      },
    });
    const childStore: AuthProfileStore = createAuthProfileStoreFixture({
      "claude-cli:token": {
        type: "token",
        provider: "claude-cli",
        token: "setup-token",
      },
    });

    const before = buildAuthHealthSummary({ cfg, store: childStore });
    const result = repair(cfg, [mainStore, childStore]);
    const after = buildAuthHealthSummary({ cfg: result.config, store: childStore });

    expect(before.providers).toEqual([
      expect.objectContaining({ provider: "claude-cli", status: "missing", effectiveProfiles: [] }),
    ]);
    expect(result.config.auth?.order).toEqual({});
    expect(after.providers).toEqual([
      expect.objectContaining({
        provider: "claude-cli",
        status: "ok",
        effectiveProfiles: [expect.objectContaining({ profileId: "claude-cli:token" })],
      }),
    ]);
    expect(
      resolveAuthProfileOrder({ cfg: result.config, store: mainStore, provider: "anthropic" }),
    ).toEqual(["anthropic:oauth"]);
    expect(
      resolveAuthProfileOrder({ cfg: result.config, store: childStore, provider: "claude-cli" }),
    ).toEqual(["claude-cli:token"]);
  });

  it("does not use a registered inactive store as the automatic fallback proof", async () => {
    await withStateDir("openclaw-custom-fallback-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const database = openOpenClawAgentDatabase({
        agentId: "retained",
        env,
        path: resolveAuthProfileDatabasePath(customAgentDir),
      });
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "claude-cli:inactive-token" }),
        customAgentDir,
        database,
      );
      closeAuthDatabases();
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { main: {} },
      });

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result).toEqual({ config: cfg, changes: [] });
    });
  });

  it("does not repair while a registered custom agent has an unmigrated auth store", async () => {
    await withStateDir("openclaw-custom-legacy-auth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      writeMainToken(stateDir);
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeAuthDatabases();
      await fs.writeFile(
        resolveAuthStorePath(customAgentDir),
        JSON.stringify(tokenStore({ profileId: "anthropic:legacy", provider: "anthropic" })),
      );
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { main: {} },
      });

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result).toEqual({ config: cfg, changes: [] });
    });
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling retained-agent symlink",
    async () => {
      await withStateDir("openclaw-dangling-auth-order-", async (stateDir) => {
        writeMainToken(stateDir);
        const retainedRoot = path.join(stateDir, "agents", "retained");
        await fs.mkdir(retainedRoot, { recursive: true });
        await fs.symlink(
          path.join(stateDir, "missing-agent"),
          path.join(retainedRoot, "agent"),
          "dir",
        );
        const cfg = anthropicOrderConfig("anthropic:missing");

        const result = repairPersisted(cfg, stateDir);

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      });
    },
  );

  it("preserves profiles in the PI_CODING_AGENT_DIR-selected auth store", async () => {
    await withStateDir("openclaw-env-auth-order-", async (stateDir) => {
      const selectedAgentDir = path.join(stateDir, "selected-agent");
      writeTokenStore(selectedAgentDir, { profileId: "claude-cli:selected-token" });
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
  });

  it("uses OPENCLAW_AGENT_DIR as the inherited shared-main auth store", async () => {
    await withStateDir("openclaw-main-auth-order-", async (stateDir) => {
      const sharedMainAgentDir = path.join(stateDir, "relocated-main-agent");
      writeTokenStore(sharedMainAgentDir, {
        profileId: "anthropic:relocated-main",
        provider: "anthropic",
      });
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
  });

  it("preserves an order that selects a runtime-only external profile", async () => {
    await withStateDir("openclaw-runtime-auth-order-", async (stateDir) => {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
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
        params.context.agentDir === workAgentDir &&
        params.context.store.profiles["openai:main-seed"]
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
  });

  it("warns and does not repair when an active auth database is unreadable", async () => {
    await withStateDir("openclaw-unreadable-auth-order-", async (stateDir) => {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      writeMainToken(stateDir);
      await fs.mkdir(workAgentDir, { recursive: true });
      await fs.writeFile(resolveAuthProfileDatabasePath(workAgentDir), "not-a-sqlite-database");
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { work: {} },
      });

      const result = repairPersisted(cfg, stateDir);

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
      expect(
        collectStaleConfiguredAuthOrderWarnings({
          cfg,
          doctorFixCommand: "openclaw doctor --fix",
          env: { OPENCLAW_STATE_DIR: stateDir },
        }).join("\n"),
      ).toContain("SQLite auth profile store is unreadable");
    });
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling active auth database symlink",
    async () => {
      await withStateDir("openclaw-active-dangling-auth-order-", async (stateDir) => {
        writeMainToken(stateDir);
        const workAgentDir = path.join(stateDir, "agents", "work", "agent");
        await fs.mkdir(workAgentDir, { recursive: true });
        await fs.symlink(
          path.join(workAgentDir, "missing.sqlite"),
          resolveAuthProfileDatabasePath(workAgentDir),
        );
        const cfg = anthropicOrderConfig("anthropic:missing", {
          entries: { work: {} },
        });

        const result = repairPersisted(cfg, stateDir);

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling legacy auth source beside a legacy database",
    async () => {
      await withStateDir("openclaw-dangling-legacy-auth-order-", async (stateDir) => {
        writeMainToken(stateDir);
        const workAgentDir = path.join(stateDir, "agents", "work", "agent");
        await fs.mkdir(workAgentDir, { recursive: true });
        const legacyDatabase = new DatabaseSync(resolveAuthProfileDatabasePath(workAgentDir));
        legacyDatabase.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
        legacyDatabase.close();
        await fs.symlink(
          path.join(workAgentDir, "missing-auth-profiles.json"),
          resolveAuthStorePath(workAgentDir),
        );
        const cfg = anthropicOrderConfig("anthropic:missing", {
          entries: { work: {} },
        });

        const result = repairPersisted(cfg, stateDir);

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      });
    },
  );

  it("fails closed when a registered custom auth database is unreadable", async () => {
    await withStateDir("openclaw-custom-invalid-auth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      writeMainToken(stateDir);
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeAuthDatabases();
      await fs.writeFile(databasePath, "not-sqlite");
      const cfg = anthropicOrderConfig("anthropic:missing");

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    });
  });

  it("fails closed when registered auth runtime state is unreadable without a secrets row", async () => {
    await withStateDir("openclaw-custom-state-auth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      writeMainToken(stateDir);
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      const database = openOpenClawAgentDatabase({
        agentId: "retained",
        env,
        path: databasePath,
      });
      writePersistedAuthProfileStateRaw(
        { version: 1, order: { anthropic: ["anthropic:retained"] } },
        customAgentDir,
        database,
      );
      closeAuthDatabases();
      const rawDatabase = new DatabaseSync(databasePath);
      rawDatabase
        .prepare("UPDATE auth_profile_state SET state_json = ? WHERE state_key = ?")
        .run("{", "primary");
      rawDatabase.close();
      const cfg = anthropicOrderConfig("anthropic:missing");

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("unreadable");
    });
  });

  it("fails closed when a registered auth database owner no longer matches", async () => {
    await withStateDir("openclaw-custom-owner-auth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      writeMainToken(stateDir);
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeAuthDatabases();
      const rawDatabase = new DatabaseSync(databasePath);
      rawDatabase
        .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = ?")
        .run("replacement", "primary");
      rawDatabase.close();
      const cfg = anthropicOrderConfig("anthropic:missing");

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    });
  });

  it("uses the live owner after a registered database pathname is recreated", async () => {
    await withStateDir("openclaw-reowned-auth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
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
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { main: {} },
      });

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toBeUndefined();
    });
  });

  it("fails closed when an active agent points at another agent's database", async () => {
    await withStateDir("openclaw-active-owner-auth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      writeMainToken(stateDir);
      const customAgentDir = path.join(stateDir, "custom-agents", "shared");
      const database = openOpenClawAgentDatabase({
        agentId: "other",
        env,
        path: resolveAuthProfileDatabasePath(customAgentDir),
      });
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "anthropic:other", provider: "anthropic" }),
        customAgentDir,
        database,
      );
      closeAuthDatabases();
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { work: { agentDir: customAgentDir } },
      });

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    });
  });

  it("fails closed when an ownerless active database contains auth tables", async () => {
    await withStateDir("openclaw-ownerless-auth-", async (stateDir) => {
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
        .run(
          "primary",
          JSON.stringify(tokenStore({ profileId: "claude-cli:setup-token" })),
          Date.now(),
        );
      rawDatabase.close();
      const cfg = anthropicOrderConfig("anthropic:missing");

      const result = repairPersisted(cfg, stateDir);

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    });
  });

  it("fails closed when an environment-selected directory belongs to another agent", async () => {
    await withStateDir("openclaw-env-owner-auth-", async (stateDir) => {
      const envAgentDir = path.join(stateDir, "custom-env-agent");
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: envAgentDir };
      writeMainToken(stateDir);
      const database = openOpenClawAgentDatabase({
        agentId: "other",
        env,
        path: resolveAuthProfileDatabasePath(envAgentDir),
      });
      writePersistedAuthProfileStoreRaw(
        tokenStore({ profileId: "anthropic:other", provider: "anthropic" }),
        envAgentDir,
        database,
      );
      closeAuthDatabases();
      const cfg = anthropicOrderConfig("anthropic:missing");

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    });
  });

  it("fails closed when an active auth database has only one auth table", async () => {
    await withStateDir("openclaw-partial-schema-auth-", async (stateDir) => {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      writeMainToken(stateDir);
      writeTokenStore(workAgentDir, { profileId: "anthropic:work", provider: "anthropic" });
      closeAuthDatabases();
      const rawDatabase = new DatabaseSync(resolveAuthProfileDatabasePath(workAgentDir));
      rawDatabase.exec("DROP TABLE auth_profile_state;");
      rawDatabase.close();
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { work: {} },
      });

      const result = repairPersisted(cfg, stateDir);

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("Skipped auth.order repair");
    });
  });

  it("fails closed when a stale registered database leaves a SQLite sidecar", async () => {
    await withStateDir("openclaw-custom-sidecar-auth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      writeMainToken(stateDir);
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeAuthDatabases();
      await fs.rm(databasePath);
      const [, walPath] = resolveAuthProfileDatabaseFilePaths(customAgentDir);
      if (!walPath) {
        throw new Error("expected SQLite WAL path");
      }
      await fs.writeFile(walPath, "orphaned-wal");
      const cfg = anthropicOrderConfig("anthropic:missing");

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("unavailable");
    });
  });

  it("ignores a stale registered auth database after its pathname is removed", async () => {
    await withStateDir("openclaw-custom-missing-auth-", async (stateDir) => {
      const env = { OPENCLAW_STATE_DIR: stateDir };
      writeMainToken(stateDir);
      const customAgentDir = path.join(stateDir, "custom-agents", "retained");
      const databasePath = resolveAuthProfileDatabasePath(customAgentDir);
      openOpenClawAgentDatabase({ agentId: "retained", env, path: databasePath });
      closeAuthDatabases();
      await fs.rm(databasePath);
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { main: {} },
      });

      const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toBeUndefined();
    });
  });

  it.skipIf(process.platform === "win32")(
    "fails closed on a dangling registered auth database parent symlink",
    async () => {
      await withStateDir("openclaw-custom-dangling-parent-auth-", async (stateDir) => {
        const env = { OPENCLAW_STATE_DIR: stateDir };
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
        const cfg = anthropicOrderConfig("anthropic:missing");

        const result = maybeRepairStaleConfiguredAuthOrders({ cfg, env });

        expect(result.config).toBe(cfg);
        expect(result.changes).toEqual([]);
        expect(result.warnings?.join("\n")).toContain("unavailable");
      });
    },
  );

  it("warns and preserves an ordered profile dropped by store coercion", async () => {
    await withStateDir("openclaw-invalid-auth-order-", async (stateDir) => {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            "anthropic:old": { type: "invalid", provider: "anthropic" },
            "claude-cli:setup-token": {
              type: "token",
              provider: "claude-cli",
              token: "setup-token",
            },
          },
        },
        path.join(stateDir, "agents", "main", "agent"),
      );
      const cfg = anthropicOrderConfig("anthropic:old");

      const result = repairPersisted(cfg, stateDir);

      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain("contains invalid credentials");
    });
  });

  it("repairs when an active agent database has no auth-profile row", async () => {
    await withStateDir("openclaw-empty-auth-order-", async (stateDir) => {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      writePersistedAuthProfileStateRaw({ version: 1 }, workAgentDir);
      writeMainToken(stateDir);
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { work: {} },
      });

      const result = repairPersisted(cfg, stateDir);

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
    });
  });

  it("repairs when an active legacy agent database predates auth tables", async () => {
    await withStateDir("openclaw-legacy-db-auth-order-", async (stateDir) => {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      const databasePath = resolveAuthProfileDatabasePath(workAgentDir);
      await fs.mkdir(workAgentDir, { recursive: true });
      const legacyDatabase = new DatabaseSync(databasePath);
      legacyDatabase.exec("CREATE TABLE legacy_state (id INTEGER PRIMARY KEY);");
      legacyDatabase.close();
      writeMainToken(stateDir);
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { work: {} },
      });

      const result = repairPersisted(cfg, stateDir);

      expect(result.config.auth?.order?.anthropic).toBeUndefined();
    });
  });

  it("does not repair while an invalid legacy auth source remains", async () => {
    await withStateDir("openclaw-legacy-auth-order-", async (stateDir) => {
      const workAgentDir = path.join(stateDir, "agents", "work", "agent");
      await fs.mkdir(workAgentDir, { recursive: true });
      await fs.writeFile(resolveLegacyAuthStorePath(workAgentDir), "not-json", "utf8");
      writeMainToken(stateDir);
      const cfg = anthropicOrderConfig("anthropic:missing", {
        entries: { work: {} },
      });

      const result = repairPersisted(cfg, stateDir);

      expect(result).toEqual({ config: cfg, changes: [] });
    });
  });
});
