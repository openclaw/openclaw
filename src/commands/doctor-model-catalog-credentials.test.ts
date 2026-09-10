// Doctor migrates model credentials before removing plaintext from generated catalogs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import {
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeMigrateModelCatalogCredentials } from "./doctor-model-catalog-credentials.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const tempDirs: string[] = [];

function createState(): { agentDir: string; env: NodeJS.ProcessEnv; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-catalog-credentials-"));
  tempDirs.push(stateDir);
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    agentDir,
    stateDir,
    env: { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir },
  };
}

function provider(apiKey: string) {
  return {
    api: "openai-completions" as const,
    apiKey,
    baseUrl: "https://models.example/v1",
    models: [
      {
        id: "example-model",
        name: "Example model",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  };
}

function migrationParams(state: ReturnType<typeof createState>, cfg: OpenClawConfig) {
  return {
    cfg,
    env: state.env,
    prompter: { shouldRepair: true } as DoctorPrompter,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor model catalog credential migration", () => {
  it.each([true, false])(
    "preserves legacy exact profiles with an authored auth alias (config=%s)",
    async (includeConfig) => {
      const state = createState();
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            arcee: {
              baseUrl: "https://openrouter.ai/api/v1",
              models: [],
            },
          },
        },
      };
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            named: { type: "api_key", provider: "openrouter", key: "alias-canonical-fixture" },
          },
        },
        state.agentDir,
      );
      const rootPath = path.join(state.agentDir, "models.json");
      const contents = JSON.stringify({
        providers: {
          arcee: {
            ...provider("named"),
            baseUrl: "https://openrouter.ai/api/v1",
          },
        },
      });
      fs.writeFileSync(rootPath, contents);
      expect(
        await maybeMigrateModelCatalogCredentials(migrationParams(state, includeConfig ? cfg : {})),
      ).toMatchObject({
        detected: 0,
        migrated: 0,
        warnings: [],
      });
      expect(fs.readFileSync(rootPath, "utf8")).toBe(contents);
      expect(loadPersistedAuthProfileStore(state.agentDir)?.profiles.named).toMatchObject({
        key: "alias-canonical-fixture",
      });
    },
  );

  it("copies config, root, and plugin catalog keys before runtime retires plaintext", async () => {
    const state = createState();
    const { agentDir } = state;
    const cfg: OpenClawConfig = {
      models: { providers: { configured: provider("configured-secret") } },
    };
    const rootContents = `{
      // Root catalogs use the same comment-tolerant syntax as ModelRegistry.
      "providers": { "root": ${JSON.stringify(provider("root-secret"))}, },
    }\n`;
    fs.writeFileSync(path.join(agentDir, "models.json"), rootContents);
    const pluginContents = `${JSON.stringify(
      {
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: { plugin: provider("plugin-secret") },
      },
      null,
      2,
    )}\n`;
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("plugin-owner")]: pluginContents,
      },
    });

    const first = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));

    expect(first.detected).toBe(3);
    expect(first.migrated).toBe(3);
    expect(first.warnings).toEqual([]);
    expect(cfg.models?.providers?.configured?.apiKey).toBe("configured-secret");
    const migratedProfiles = loadPersistedSharedAuthProfileStore(state.env)?.profiles ?? {};
    expect(migratedProfiles).toMatchObject({
      "configured:default": {
        type: "api_key",
        provider: "configured",
        key: "configured-secret",
      },
      "root:default": { type: "api_key", provider: "root", key: "root-secret" },
      "plugin:default": { type: "api_key", provider: "plugin", key: "plugin-secret" },
    });
    const publishedRoot = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
    expect(publishedRoot).toBe(
      rootContents.replace('"root-secret"', '"auth-profile:root:default"'),
    );
    expect(publishedRoot).not.toContain("root-secret");
    const pluginCatalog = loadPersistedPluginModelCatalogsReadOnly(agentDir)[0];
    expect(JSON.parse(pluginCatalog?.contents ?? "{}").providers.plugin.apiKey).toBe(
      "auth-profile:plugin:default",
    );
    expect(pluginCatalog?.contents).not.toContain("plugin-secret");

    const second = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));
    expect(second).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
  });

  it.each(["root", "plugin"])(
    "publishes verified %s references despite another provider's profile-ID collision",
    async (source) => {
      const state = createState();
      const apiKey = "other:catalog";
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [apiKey]: { type: "api_key", provider: "other", key: "unrelated-synthetic-key" },
          },
        },
        state.agentDir,
      );
      const rootPath = path.join(state.agentDir, "models.json");
      const contents = JSON.stringify({
        ...(source === "plugin" ? { generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY } : {}),
        operatorNote: "keep authored metadata",
        providers: { custom: provider(apiKey) },
      });
      if (source === "root") {
        fs.writeFileSync(rootPath, contents);
      } else {
        fs.writeFileSync(rootPath, JSON.stringify({ providers: {} }));
        replacePersistedPluginModelCatalogs({
          agentDir: state.agentDir,
          pluginCatalogWrites: {
            [encodePluginModelCatalogRelativePath("catalog-owner")]: contents,
          },
        });
      }
      expect(await maybeMigrateModelCatalogCredentials(migrationParams(state, {}))).toMatchObject({
        migrated: 1,
        warnings: [],
      });
      const published =
        source === "root"
          ? fs.readFileSync(rootPath, "utf8")
          : (loadPersistedPluginModelCatalogsReadOnly(state.agentDir)[0]?.contents ?? "{}");
      expect(JSON.parse(published)).toMatchObject({
        operatorNote: "keep authored metadata",
        providers: { custom: { apiKey: "auth-profile:custom:default" } },
      });
      const { ModelRegistry } = await import("../agents/sessions/model-registry.js");
      const { AuthStorage } = await import("../agents/sessions/auth-storage.js");
      const { createPluginMetadataSnapshotFixture } =
        await import("../plugins/plugin-metadata.test-support.js");
      const registry = ModelRegistry.create(AuthStorage.forAgent(state.agentDir, {}), rootPath, {
        pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "catalog-owner", providers: ["custom"] }],
        }),
      });
      const model = registry.find("custom", "example-model");
      assert(model, "The migrated catalog must retain its model");
      expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({ apiKey });
      expect(loadPersistedAuthProfileStore(state.agentDir)?.profiles[apiKey]).toMatchObject({
        provider: "other",
        key: "unrelated-synthetic-key",
      });
    },
  );

  it("preserves catalog edits made while migration confirmation is pending", async () => {
    const state = createState();
    const rootPath = path.join(state.agentDir, "models.json");
    fs.writeFileSync(
      rootPath,
      JSON.stringify({ providers: { custom: provider("old-fixture-key") } }),
    );
    const current = JSON.stringify({
      operatorNote: "new writer",
      providers: { custom: provider("replacement-fixture-key") },
    });
    const params = migrationParams(state, {});
    params.prompter = createDoctorPrompter({ runtime: params.runtime, options: {} });
    vi.spyOn(params.prompter, "confirmAutoFix").mockImplementation(async () => {
      fs.writeFileSync(rootPath, current);
      return true;
    });
    expect(await maybeMigrateModelCatalogCredentials(params)).toMatchObject({
      migrated: 1,
      warnings: [],
    });
    expect(fs.readFileSync(rootPath, "utf8")).toBe(current);
  });

  it("preserves custom provider env references and removes profiles containing their markers", async () => {
    const state = createState();
    const cfg: OpenClawConfig = {
      models: { providers: { custom: provider("${CUSTOM_PROVIDER_KEY}") } },
    };
    fs.writeFileSync(
      path.join(state.agentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("CUSTOM_PROVIDER_KEY") } }, null, 2)}\n`,
    );

    const first = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));

    expect(first).toEqual({ detected: 0, migrated: 0, removed: 0, warnings: [] });
    expect(loadPersistedSharedAuthProfileStore(state.env)).toBeNull();

    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": {
            type: "api_key",
            provider: "custom",
            key: "${CUSTOM_PROVIDER_KEY}",
          },
          "custom:models-json": {
            type: "api_key",
            provider: "custom",
            key: "CUSTOM_PROVIDER_KEY",
          },
        },
        order: { custom: ["custom:default", "custom:models-json"] },
        lastGood: { custom: "custom:default" },
      },
      state.agentDir,
    );

    const repaired = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));

    expect(repaired).toEqual({ detected: 0, migrated: 0, removed: 2, warnings: [] });
    expect(loadPersistedSharedAuthProfileStore(state.env)).toEqual({ version: 1, profiles: {} });
  });

  it.each(["main", "helper"])(
    "preserves a %s credential replaced while the repair prompt is pending",
    async (agentId) => {
      const state = createState();
      const agentDir = path.join(state.stateDir, "agents", agentId, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: { agentDir: state.agentDir }, [agentId]: { agentDir } },
        },
        models: { providers: { custom: provider("${CUSTOM_PROVIDER_KEY}") } },
      };
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "CUSTOM_PROVIDER_KEY" },
          "custom:models-json": {
            type: "api_key",
            provider: "custom",
            key: "$CUSTOM_PROVIDER_KEY",
          },
        },
        order: { custom: ["custom:default", "custom:models-json"] },
        lastGood: { custom: "custom:default" },
        usageStats: { "custom:default": { lastUsed: 123, errorCount: 0 } },
      };
      saveAuthProfileStore(store, agentDir);
      const params = migrationParams(state, cfg);
      params.prompter = {
        ...createDoctorPrompter({ runtime: params.runtime, options: {} }),
        confirmAutoFix: async () => {
          store.profiles["custom:default"] = {
            type: "api_key",
            provider: "custom",
            key: "replacement-secret",
          };
          saveAuthProfileStore(store, agentDir);
          return true;
        },
      };

      const result = await maybeMigrateModelCatalogCredentials(params);

      expect(result).toEqual({ detected: 0, migrated: 0, removed: 1, warnings: [] });
      expect(loadPersistedAuthProfileStore(agentDir)).toEqual({
        version: 1,
        profiles: { "custom:default": store.profiles["custom:default"] },
        order: { custom: ["custom:default"] },
        lastGood: store.lastGood,
        usageStats: store.usageStats,
      });
    },
  );

  it("does not copy a stale generated credential over an explicit provider SecretRef", async () => {
    const state = createState();
    const cfg: OpenClawConfig = {
      models: { providers: { custom: provider("${CUSTOM_PROVIDER_KEY}") } },
    };
    fs.writeFileSync(
      path.join(state.agentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("stale-provider-key") } }, null, 2)}\n`,
    );

    await expect(maybeMigrateModelCatalogCredentials(migrationParams(state, cfg))).resolves.toEqual(
      { detected: 0, migrated: 0, removed: 0, warnings: [] },
    );
    expect(loadPersistedSharedAuthProfileStore(state.env)).toBeNull();
  });

  it("never overwrites an occupied default profile while preserving the catalog key", async () => {
    const state = createState();
    const { agentDir } = state;
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": {
            type: "api_key",
            provider: "custom",
            key: "existing-secret",
          },
        },
        order: { custom: ["custom:default"] },
      },
      agentDir,
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("catalog-secret") } }, null, 2)}\n`,
    );

    await maybeMigrateModelCatalogCredentials(migrationParams(state, {}));

    const store = loadPersistedAuthProfileStore(agentDir);
    expect(store?.profiles["custom:default"]).toMatchObject({ key: "existing-secret" });
    expect(store?.profiles["custom:models-json"]).toMatchObject({ key: "catalog-secret" });
    expect(store?.order?.custom).toEqual(["custom:default"]);
  });

  it("refuses to overwrite an unreadable canonical auth store", async () => {
    const state = createState();
    const { agentDir } = state;
    const unreadable = { version: 1, profiles: "not-a-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadable, agentDir);
    const rootContents = `${JSON.stringify({ providers: { custom: provider("catalog-secret") } })}\n`;
    fs.writeFileSync(path.join(agentDir, "models.json"), rootContents);

    const result = await maybeMigrateModelCatalogCredentials(migrationParams(state, {}));

    expect(result.migrated).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadable);
    expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe(rootContents);
  });

  it("recognizes profile references inherited from the shared main store", async () => {
    const state = createState();
    const childAgentDir = path.join(state.stateDir, "agents", "child", "agent");
    fs.mkdirSync(childAgentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "stored-secret" },
        },
      },
      state.agentDir,
    );
    fs.writeFileSync(
      path.join(childAgentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("custom:default") } })}\n`,
    );

    const result = await maybeMigrateModelCatalogCredentials(migrationParams(state, {}));

    expect(result).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
    expect(loadPersistedAuthProfileStore(childAgentDir)).toBeNull();
  });

  it("scans an explicit multi-agent roster without requiring a legacy default", async () => {
    const state = createState();
    const helperAgentDir = path.join(state.stateDir, "agents", "helper", "agent");
    const thirdAgentDir = path.join(state.stateDir, "agents", "third", "agent");
    fs.mkdirSync(helperAgentDir, { recursive: true });
    fs.mkdirSync(thirdAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(helperAgentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("helper-catalog-secret") } })}\n`,
    );
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { agentDir: state.agentDir },
          helper: { agentDir: helperAgentDir },
          third: { agentDir: thirdAgentDir },
        },
      },
    } satisfies OpenClawConfig;

    await expect(maybeMigrateModelCatalogCredentials(migrationParams(state, cfg))).resolves.toEqual(
      { detected: 1, migrated: 1, removed: 0, warnings: [] },
    );
    expect(loadPersistedAuthProfileStore(helperAgentDir)?.profiles["custom:default"]).toMatchObject(
      {
        key: "helper-catalog-secret",
      },
    );
  });

  it("allocates a global config profile that child stores cannot shadow", async () => {
    const state = createState();
    const childAgentDir = path.join(state.stateDir, "agents", "child", "agent");
    fs.mkdirSync(childAgentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "configured-secret" },
        },
      },
      state.agentDir,
    );
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": { type: "api_key", provider: "custom", key: "child-secret" },
        },
      },
      childAgentDir,
    );

    const result = await maybeMigrateModelCatalogCredentials(
      migrationParams(state, {
        models: { providers: { custom: provider("configured-secret") } },
      }),
    );

    expect(result).toMatchObject({ detected: 1, migrated: 1, warnings: [] });
    expect(
      loadPersistedAuthProfileStore(state.agentDir)?.profiles["custom:models-json"],
    ).toMatchObject({ key: "configured-secret" });
    expect(loadPersistedAuthProfileStore(childAgentDir)?.profiles["custom:default"]).toMatchObject({
      key: "child-secret",
    });
  });
});
