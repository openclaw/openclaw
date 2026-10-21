// Doctor migrates model credentials before removing plaintext from generated catalogs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../agents/auth-profiles/persisted.js";
import {
  closeAuthProfileReadPool,
  readPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { removePersistedPluginModelCatalogCredentials } from "../agents/plugin-model-catalog-credentials.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  migrateLegacyPluginModelCatalogs,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
} from "../agents/plugin-model-catalog.js";
import { createConfigIO } from "../config/io.factory.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { maybeMigrateModelCatalogCredentials } from "./doctor-model-catalog-credentials.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const tempDirs: string[] = [];

function createState(): { agentDir: string; env: NodeJS.ProcessEnv; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-catalog-credentials-"));
  tempDirs.push(stateDir);
  const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  openOpenClawStateDatabase({ env });
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  return {
    agentDir,
    stateDir,
    env,
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

function importLegacyCatalog(state: ReturnType<typeof createState>, contents: string) {
  const pathname = path.join(state.agentDir, encodePluginModelCatalogRelativePath("plugin-owner"));
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, contents);
  expect(migrateLegacyPluginModelCatalogs({ agentDir: state.agentDir })).toEqual({
    migrated: 1,
    warnings: [],
  });
}

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    // Physical admissions outlive native handles; retire them before deleting fixture files.
    const root = `${fs.realpathSync(dir)}${path.sep}`;
    closeAuthProfileReadPool({ kind: "root", rootPath: root });
    for (const { location } of captureSqliteDatabaseAdmissions()) {
      if (location.startsWith(root)) {
        retireSqliteDatabaseAdmissionForPath(location);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor model catalog credential migration", () => {
  it("retires already-canonical generated credentials without changing authored root bytes", async () => {
    const state = createState();
    const key = "synthetic-canonical-plugin-key";
    saveAuthProfileStore(
      createAuthProfileStoreFixture({ "plugin:default": createApiKeyCredential("plugin", key) }),
      state.agentDir,
    );
    const rootContents = `// Authored literals remain supported.\n${JSON.stringify({ providers: { plugin: provider(key) } })}\n`;
    fs.writeFileSync(path.join(state.agentDir, "models.json"), rootContents);
    importLegacyCatalog(
      state,
      JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          plugin: {
            ...provider(key),
            headers: { Authorization: `Bearer ${key}` },
            models: [
              {
                ...provider(key).models[0],
                apiKey: key,
                headers: { Authorization: `Bearer ${key}` },
              },
            ],
          },
        },
      }),
    );

    const result = await maybeMigrateModelCatalogCredentials(migrationParams(state, {}));

    expect(result).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
    expect(fs.readFileSync(path.join(state.agentDir, "models.json"), "utf8")).toBe(rootContents);
    const persisted = JSON.parse(
      loadPersistedPluginModelCatalogsReadOnly(state.agentDir)[0]!.contents,
    );
    expect(persisted.providers.plugin).not.toHaveProperty("apiKey");
    expect(persisted.providers.plugin).not.toHaveProperty("headers");
    expect(persisted.providers.plugin.models[0]).toEqual(provider(key).models[0]);
    expect(
      loadPersistedSharedAuthProfileStore(state.env)?.profiles["plugin:default"],
    ).toMatchObject({ key });
  });

  it("does not recover a generated credential removed while confirmation is pending", async () => {
    const state = createState();
    // Keep the original failing confirmation path; generated-only discovery is covered below.
    fs.writeFileSync(path.join(state.agentDir, "models.json"), '{"providers":{}}\n');
    importLegacyCatalog(
      state,
      JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: { plugin: provider("synthetic-removed-before-confirmation") },
      }),
    );
    const params = migrationParams(state, {});
    const confirmAutoFix = vi.fn(async () => {
      expect(
        JSON.parse(loadPersistedPluginModelCatalogsReadOnly(state.agentDir)[0]!.contents).providers
          .plugin.apiKey,
      ).toBe("synthetic-removed-before-confirmation");
      await removePersistedPluginModelCatalogCredentials({
        candidates: [
          {
            agentId: resolveAuthProfileDatabaseOwnerId(state.agentDir),
            databasePath: resolveAuthProfileDatabasePath(state.agentDir),
          },
        ],
        credentials: new Set(["synthetic-removed-before-confirmation"]),
        env: state.env,
      });
      return true;
    });
    params.prompter = {
      ...createDoctorPrompter({ runtime: params.runtime, options: {} }),
      confirmAutoFix,
    };

    const result = await maybeMigrateModelCatalogCredentials(params);

    expect(result.detected).toBe(1);
    expect(confirmAutoFix).toHaveBeenCalledOnce();
    expect(result.migrated).toBe(0);
    expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles ?? {}).toEqual({});
    const persisted = JSON.parse(
      loadPersistedPluginModelCatalogsReadOnly(state.agentDir)[0]!.contents,
    );
    expect(persisted.providers.plugin).not.toHaveProperty("apiKey");
  });

  it("does not recover an authored credential removed while confirmation is pending", async () => {
    const state = createState();
    const rootPath = path.join(state.agentDir, "models.json");
    fs.writeFileSync(
      rootPath,
      JSON.stringify({ providers: { custom: provider("removed-root-key") } }),
    );
    const params = migrationParams(state, {});
    const confirmAutoFix = vi.fn(async () => {
      fs.writeFileSync(rootPath, '{"providers":{}}\n');
      return true;
    });
    params.prompter = {
      ...createDoctorPrompter({ runtime: params.runtime, options: {} }),
      confirmAutoFix,
    };

    const result = await maybeMigrateModelCatalogCredentials(params);

    expect(result).toMatchObject({ detected: 1, migrated: 0, warnings: [] });
    expect(confirmAutoFix).toHaveBeenCalledOnce();
    expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles ?? {}).toEqual({});
    expect(fs.readFileSync(rootPath, "utf8")).toBe('{"providers":{}}\n');
  });

  it.each(["root", "include"])(
    "preserves generated headers when their authored %s source changes during confirmation",
    async (source) => {
      const state = createState();
      const cfg: OpenClawConfig = {
        models: {
          providers: { custom: { ...provider(""), headers: { "X-Owned": "synthetic-header" } } },
        },
      };
      const configPath = path.join(state.stateDir, "openclaw.json");
      state.env.OPENCLAW_CONFIG_PATH = configPath;
      const sourcePath =
        source === "root" ? configPath : path.join(state.stateDir, "providers.json");
      fs.writeFileSync(sourcePath, JSON.stringify(source === "root" ? cfg : cfg.models));
      if (source === "include") {
        fs.writeFileSync(configPath, JSON.stringify({ models: { $include: "providers.json" } }));
      }
      const contents = JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: cfg.models!.providers,
      });
      importLegacyCatalog(state, contents);
      const params = migrationParams(state, cfg);
      const confirmAutoFix = vi.fn(async () => {
        fs.writeFileSync(sourcePath, "{}\n");
        return true;
      });
      params.prompter = {
        ...createDoctorPrompter({ runtime: params.runtime, options: {} }),
        confirmAutoFix,
      };

      const result = await maybeMigrateModelCatalogCredentials(params);

      expect(confirmAutoFix).toHaveBeenCalledOnce();
      expect(loadPersistedPluginModelCatalogsReadOnly(state.agentDir)[0]!.contents).toBe(contents);
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("config changed")]),
      );
      expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles ?? {}).toEqual({});
    },
  );

  it.each(["key", "header"])(
    "rejects stale included %s authority captured before credential repair",
    async (authority) => {
      const state = createState();
      const configPath = path.join(state.stateDir, "openclaw.json");
      const includePath = path.join(state.stateDir, "providers.json");
      state.env.OPENCLAW_CONFIG_PATH = configPath;
      const entry = {
        ...provider(authority === "key" ? "synthetic-removed-config-key" : ""),
        ...(authority === "header" ? { headers: { "X-Owned": "synthetic-removed-header" } } : {}),
      };
      fs.writeFileSync(includePath, JSON.stringify({ providers: { custom: entry } }));
      fs.writeFileSync(configPath, JSON.stringify({ models: { $include: "providers.json" } }));
      const io = createConfigIO({ env: state.env, configPath, pluginValidation: "skip" });
      const confirmed = await io.readConfigFileSnapshotForWrite();
      expect(confirmed.snapshot.hash).toEqual(expect.any(String));
      expect(confirmed.snapshot.config.models?.providers?.custom).toMatchObject(entry);
      const contents = JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: authority === "header" ? { custom: entry } : {},
      });
      importLegacyCatalog(state, contents);
      // Doctor captured cfg and its composite revision before this function was reached.
      // Replacing only an include must invalidate that receipt despite unchanged root bytes.
      fs.writeFileSync(includePath, "{}\n");
      const changed = await io.readConfigFileSnapshotForWrite();
      expect(changed.snapshot.raw).toBe(confirmed.snapshot.raw);
      expect(changed.snapshot.hash).not.toBe(confirmed.snapshot.hash);

      const result = await maybeMigrateModelCatalogCredentials({
        ...migrationParams(state, confirmed.snapshot.config),
        configSource: { path: configPath, hash: confirmed.snapshot.hash ?? null },
      });

      expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles ?? {}).toEqual({});
      expect(loadPersistedPluginModelCatalogsReadOnly(state.agentDir)[0]!.contents).toBe(contents);
      expect(result).toMatchObject({ migrated: 0, removed: 0 });
      expect(result.warnings).toEqual([expect.stringContaining("config changed")]);
    },
  );

  it("migrates generated-only configured agents without scanning unconfigured agent data", async () => {
    const state = createState();
    const childDir = path.join(state.stateDir, "agents", "child", "agent");
    const inactiveDir = path.join(state.stateDir, "agents", "inactive", "agent");
    const contents = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: { plugin: provider("generated-only-key") },
    });
    for (const agentDir of [childDir, inactiveDir]) {
      importLegacyCatalog({ ...state, agentDir }, contents);
    }
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { main: { agentDir: state.agentDir }, child: { agentDir: childDir } },
      },
    };

    const result = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));

    expect(result).toMatchObject({ detected: 1, migrated: 1, warnings: [] });
    expect(fs.existsSync(path.join(childDir, "models.json"))).toBe(false);
    expect(loadPersistedAuthProfileStore(childDir)?.profiles["plugin:default"]).toMatchObject({
      key: "generated-only-key",
    });
    expect(
      JSON.parse(loadPersistedPluginModelCatalogsReadOnly(childDir)[0]!.contents).providers.plugin,
    ).not.toHaveProperty("apiKey");
    expect(loadPersistedPluginModelCatalogsReadOnly(inactiveDir)[0]!.contents).toBe(contents);
    expect(loadPersistedAuthProfileStore(inactiveDir)?.profiles ?? {}).toEqual({});
  });

  it("does not import credentials using an invalidated Doctor config revision", async () => {
    const state = createState();
    const contents = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: { plugin: provider("synthetic-unconfirmed-key") },
    });
    importLegacyCatalog(state, contents);

    const result = await maybeMigrateModelCatalogCredentials({
      ...migrationParams(state, {}),
      configSource: { path: path.join(state.stateDir, "openclaw.json"), hash: null },
    });

    expect(result.migrated).toBe(0);
    expect(loadPersistedPluginModelCatalogsReadOnly(state.agentDir)[0]!.contents).toBe(contents);
    expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles ?? {}).toEqual({});
    expect(result.warnings).toEqual([expect.stringContaining("config changed")]);
  });

  it("cleans only accounted provider/model headers and leaves unmatched credentials recoverable", async () => {
    const state = createState();
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            ...provider("${CUSTOM_PROVIDER_KEY}"),
            headers: {
              "X-Owned": "authored-header",
              "X-Expected-Name": "wrong-name-value",
              "X-Clean": "matched-header",
            },
            models: [{ ...provider("").models[0]!, headers: { "X-Model": "model-header" } }],
          },
        },
      },
    };
    saveAuthProfileStore(
      createAuthProfileStoreFixture({
        "other:default": createApiKeyCredential("other", "other-provider-key"),
      }),
      state.agentDir,
    );
    const source = JSON.stringify(cfg);
    importLegacyCatalog(
      state,
      JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          custom: {
            ...provider("stale-generated-key"),
            headers: {
              Authorization: "Bearer stale-generated-key",
              "X-Owned": "authored-header",
              "X-Clean": "matched-header",
              "X-Wrong-Name": "wrong-name-value",
            },
            models: [
              {
                ...provider("").models[0],
                apiKey: "other-provider-key",
                headers: { "X-Model": "model-header" },
              },
              {
                ...provider("").models[0],
                id: "different-model",
                headers: { "X-Model": "model-header" },
              },
              {
                ...provider("").models[0],
                baseUrl: "https://other.example/v1",
                headers: { "X-Owned": "authored-header" },
              },
            ],
          },
        },
      }),
    );

    const result = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));

    expect(result).toMatchObject({ detected: 0, migrated: 0 });
    expect(result.warnings).toEqual([
      expect.stringContaining(
        'Retained unmatched model credentials or headers for provider "custom"',
      ),
    ]);
    const persisted = JSON.parse(
      loadPersistedPluginModelCatalogsReadOnly(state.agentDir)[0]!.contents,
    ).providers.custom;
    expect(persisted).not.toHaveProperty("apiKey");
    expect(persisted.headers).toEqual({
      "X-Owned": "authored-header",
      "X-Wrong-Name": "wrong-name-value",
    });
    expect(persisted.models[0].apiKey).toBe("other-provider-key");
    expect(
      persisted.models.map((model: { headers: Record<string, string> }) => model.headers),
    ).toEqual([
      { "X-Model": "model-header" },
      { "X-Model": "model-header" },
      { "X-Owned": "authored-header" },
    ]);
    expect(JSON.stringify(cfg)).toBe(source);
    expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles).toEqual({
      "other:default": createApiKeyCredential("other", "other-provider-key"),
    });
  });

  it("copies and verifies keys before cleaning generated catalogs while preserving authored sources", async () => {
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
    importLegacyCatalog(state, pluginContents);

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
    expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe(rootContents);
    const pluginCatalog = loadPersistedPluginModelCatalogsReadOnly(agentDir)[0];
    expect(JSON.parse(pluginCatalog!.contents).providers.plugin).toEqual({
      api: "openai-completions",
      baseUrl: "https://models.example/v1",
      models: provider("plugin-secret").models,
    });

    const second = await maybeMigrateModelCatalogCredentials(migrationParams(state, cfg));
    expect(second).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
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
          store.profiles["custom:default"] = createApiKeyCredential("custom", "replacement-secret");
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

  it("allocates a global config profile that child stores cannot shadow", async () => {
    const state = createState();
    const childAgentDir = path.join(state.stateDir, "agents", "child", "agent");
    fs.mkdirSync(childAgentDir, { recursive: true });
    saveAuthProfileStore(
      createAuthProfileStoreFixture({
        "custom:default": { type: "api_key", provider: "custom", key: "configured-secret" },
      }),
      state.agentDir,
    );
    saveAuthProfileStore(
      createAuthProfileStoreFixture({
        "custom:default": { type: "api_key", provider: "custom", key: "child-secret" },
      }),
      childAgentDir,
    );

    const result = await maybeMigrateModelCatalogCredentials(
      migrationParams(state, {
        agents: {
          ownership: "explicit",
          entries: { main: { agentDir: state.agentDir }, child: { agentDir: childAgentDir } },
        },
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
