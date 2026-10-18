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
  loadPersistedAuthProfileStore as readProfiles,
  loadPersistedSharedAuthProfileStore as readSharedProfiles,
} from "../agents/auth-profiles/persisted.js";
import {
  closeAuthProfileReadPool,
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
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { maybeMigrateModelCatalogCredentials as migrateCredentials } from "./doctor-model-catalog-credentials.js";
import { createDoctorPrompter, type DoctorPrompter } from "./doctor-prompter.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

const tempDirs: string[] = [];

function createState(cfg: OpenClawConfig = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-catalog-credentials-"));
  tempDirs.push(stateDir);
  const env = { ...process.env, HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  stateDb.openOpenClawStateDatabase({ env });
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const prompter = { shouldRepair: true } as DoctorPrompter;
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  return { agentDir, stateDir, env, cfg, prompter, runtime };
}

function provider(apiKey: string) {
  const baseUrl = "https://models.example/v1";
  return { api: "openai-completions" as const, apiKey, baseUrl, models: [] };
}

function providerConfig(key: string, id = "custom"): OpenClawConfig {
  return { models: { providers: { [id]: provider(key) } } };
}
const customConfig = providerConfig("${CUSTOM_PROVIDER_KEY}");
function writeRootCatalog(agentDir: string, key: string) {
  const contents = `${JSON.stringify({ providers: { custom: provider(key) } }, null, 2)}\n`;
  fs.writeFileSync(path.join(agentDir, "models.json"), contents);
  return contents;
}
function markerStore(key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "custom:default": createApiKeyCredential("custom", "${CUSTOM_PROVIDER_KEY}"),
      "custom:models-json": createApiKeyCredential("custom", key),
    },
    order: { custom: ["custom:default", "custom:models-json"] },
    lastGood: { custom: "custom:default" },
  };
}

afterEach(async () => {
  await agentDb.closeOpenClawAgentDatabasesAsync();
  agentDb.closeOpenClawAgentDatabasesForTest();
  await stateDb.closeOpenClawStateDatabaseAsync();
  stateDb.closeOpenClawStateDatabaseForTest();
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
  it("copies config, root, and plugin catalog keys before runtime retires plaintext", async () => {
    const state = createState(providerConfig("configured-secret", "configured"));
    const { agentDir } = state;
    const rootContents = `{
      // Root catalogs use the same comment-tolerant syntax as ModelRegistry.
      "providers": { "root": ${JSON.stringify(provider("root-secret"))}, },
    }\n`;
    fs.writeFileSync(path.join(agentDir, "models.json"), rootContents);
    const pluginContents = JSON.stringify({
      generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
      providers: { plugin: provider("plugin-secret") },
    });
    await replacePersistedPluginModelCatalogs({
      agentDir,
      env: state.env,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("plugin-owner")]: pluginContents,
      },
    });

    const first = await migrateCredentials(state);
    expect(first).toMatchObject({ detected: 3, migrated: 3, warnings: [] });
    expect(state.cfg.models?.providers?.configured?.apiKey).toBe("configured-secret");
    const migratedProfiles = readSharedProfiles(state.env)?.profiles ?? {};
    expect(migratedProfiles).toMatchObject({
      "configured:default": { type: "api_key", provider: "configured", key: "configured-secret" },
      "root:default": { type: "api_key", provider: "root", key: "root-secret" },
      "plugin:default": { type: "api_key", provider: "plugin", key: "plugin-secret" },
    });
    expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe(rootContents);
    const pluginCatalog = loadPersistedPluginModelCatalogsReadOnly(agentDir)[0];
    expect(pluginCatalog?.contents).toBe(pluginContents);

    const second = await migrateCredentials(state);
    expect(second).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
  });

  it.each(["CUSTOM_PROVIDER_KEY", "stale-provider-key"])(
    "does not import generated %s over an explicit provider SecretRef",
    async (key) => {
      const state = createState(customConfig);
      writeRootCatalog(state.agentDir, key);
      await expect(migrateCredentials(state)).resolves.toEqual({
        detected: 0,
        migrated: 0,
        removed: 0,
        warnings: [],
      });
      expect(readSharedProfiles(state.env)).toBeNull();
    },
  );

  it("removes stored profiles containing custom provider env markers", async () => {
    const state = createState(customConfig);
    writeRootCatalog(state.agentDir, "CUSTOM_PROVIDER_KEY");
    saveAuthProfileStore(markerStore("CUSTOM_PROVIDER_KEY"), state.agentDir);
    const repaired = await migrateCredentials(state);
    expect(repaired).toEqual({ detected: 0, migrated: 0, removed: 2, warnings: [] });
    expect(readSharedProfiles(state.env)).toEqual({ version: 1, profiles: {} });
  });

  it.each(["main", "helper"])(
    "preserves a %s credential replaced while the repair prompt is pending",
    async (agentId) => {
      const state = createState();
      const agentDir = path.join(state.stateDir, "agents", agentId, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      state.cfg = {
        ...customConfig,
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: { agentDir: state.agentDir }, [agentId]: { agentDir } },
        },
      };
      const store: AuthProfileStore = {
        ...markerStore("$CUSTOM_PROVIDER_KEY"),
        usageStats: { "custom:default": { lastUsed: 123, errorCount: 0 } },
      };
      store.profiles["custom:default"] = createApiKeyCredential("custom", "CUSTOM_PROVIDER_KEY");
      saveAuthProfileStore(store, agentDir);
      state.prompter = {
        ...createDoctorPrompter({ runtime: state.runtime, options: {} }),
        confirmAutoFix: async () => {
          store.profiles["custom:default"] = createApiKeyCredential("custom", "replacement-secret");
          saveAuthProfileStore(store, agentDir);
          return true;
        },
      };

      const result = await migrateCredentials(state);

      expect(result).toEqual({ detected: 0, migrated: 0, removed: 1, warnings: [] });
      expect(readProfiles(agentDir)).toEqual({
        version: 1,
        profiles: { "custom:default": store.profiles["custom:default"] },
        order: { custom: ["custom:default"] },
        lastGood: store.lastGood,
        usageStats: store.usageStats,
      });
    },
  );

  it("refuses to overwrite an unreadable canonical auth store", async () => {
    const state = createState();
    const { agentDir } = state;
    const unreadable = { version: 1, profiles: "not-a-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadable, agentDir);
    const rootContents = writeRootCatalog(agentDir, "catalog-secret");

    const result = await migrateCredentials(state);

    expect(result.migrated).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(readPersistedAuthProfileStoreRaw(agentDir)).toEqual(unreadable);
    expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe(rootContents);
  });

  it("allocates a global config profile that child stores cannot shadow", async () => {
    const state = createState(providerConfig("configured-secret"));
    const childAgentDir = path.join(state.stateDir, "agents", "child", "agent");
    fs.mkdirSync(childAgentDir, { recursive: true });
    const saveKey = (dir: string, key: string) =>
      saveAuthProfileStore(
        createAuthProfileStoreFixture({ "custom:default": createApiKeyCredential("custom", key) }),
        dir,
      );
    saveKey(state.agentDir, "configured-secret");
    saveKey(childAgentDir, "child-secret");

    const result = await migrateCredentials(state);
    expect(result).toMatchObject({ detected: 1, migrated: 1, warnings: [] });
    expect(readProfiles(state.agentDir)?.profiles["custom:models-json"]).toMatchObject({
      key: "configured-secret",
    });
    expect(readProfiles(childAgentDir)?.profiles["custom:default"]).toMatchObject({
      key: "child-secret",
    });
  });
});
