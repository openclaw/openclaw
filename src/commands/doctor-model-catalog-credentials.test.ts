// Doctor migrates model credentials before removing plaintext from generated catalogs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
  mergeAuthProfileStores,
} from "../agents/auth-profiles/persisted.js";
import {
  closeAuthProfileReadPool,
  readPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
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

function createState() {
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
    migrate: (cfg: OpenClawConfig = {}) =>
      maybeMigrateModelCatalogCredentials(migrationParams({ env }, cfg)),
  };
}

function provider(apiKey: string) {
  return {
    api: "openai-completions" as const,
    apiKey,
    baseUrl: "https://models.example/v1",
    models: [],
  };
}

function migrationParams(state: { env: NodeJS.ProcessEnv }, cfg: OpenClawConfig) {
  return {
    cfg,
    env: state.env,
    prompter: { shouldRepair: true } as DoctorPrompter,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
  };
}

const configWithKey = (key: string, name = "custom"): OpenClawConfig => ({
  models: { providers: { [name]: provider(key) } },
});

function markerStore(
  firstKey = "${CUSTOM_PROVIDER_KEY}",
  secondKey = "CUSTOM_PROVIDER_KEY",
): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "custom:default": credential(firstKey),
      "custom:models-json": credential(secondKey),
    },
    order: { custom: ["custom:default", "custom:models-json"] },
    lastGood: { custom: "custom:default" },
  };
}

function repairDuringPrompt(
  params: ReturnType<typeof migrationParams>,
  repair: () => void | Promise<unknown>,
) {
  params.prompter = {
    ...createDoctorPrompter({ runtime: params.runtime, options: {} }),
    confirmAutoFix: async () => {
      await repair();
      return true;
    },
  };
}

const credential = (key: string) => createApiKeyCredential("custom", key);
const migrationResult = (detected = 0, migrated = 0, removed = 0) => ({
  detected,
  migrated,
  removed,
  warnings: [],
  findings: [],
});
function writeCatalog(agentDir: string, key: string) {
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    `${JSON.stringify({ providers: { custom: provider(key) } })}\n`,
  );
}
function agentConfig(state: ReturnType<typeof createState>, agentId: string, agentDir: string) {
  return {
    ownership: "explicit" as const,
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: { agentDir: state.agentDir }, [agentId]: { agentDir } },
  };
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
  it.each([false, true])(
    "keeps shared auth effective instead of importing a stale catalog key (during prompt: %s)",
    async (duringPrompt) => {
      const state = createState();
      const agentDir = path.join(state.stateDir, "agents", "helper", "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      writeCatalog(agentDir, "stale-catalog-key");
      const source = fs.readFileSync(path.join(agentDir, "models.json"));
      const params = migrationParams(state, { agents: agentConfig(state, "helper", agentDir) });
      const installShared = () =>
        persistAuthProfileBatch({
          stateDir: state.stateDir,
          profiles: [{ profileId: "custom:default", credential: credential("current-shared-key") }],
        });
      if (duringPrompt) {
        repairDuringPrompt(params, installShared);
      } else {
        await installShared();
      }

      const result = await maybeMigrateModelCatalogCredentials(params);

      const shared = loadPersistedSharedAuthProfileStore(state.env)!;
      expect(resolveSharedAuthStorePath(state.env)).toBe(
        path.join(state.stateDir, "state", "openclaw.sqlite"),
      );
      const local = loadPersistedAuthProfileStore(agentDir) ?? createAuthProfileStoreFixture({});
      expect(result.migrated).toBe(0);
      expect(result.warnings.join("\n")).toMatch(/custom.*shared.*custom:default/);
      expect(local.profiles).toEqual({});
      const effective = mergeAuthProfileStores(shared, local);
      expect(resolveAuthProfileOrder({ store: effective, provider: "custom" })).toEqual([
        "custom:default",
      ]);
      expect(effective.profiles["custom:default"]).toEqual(credential("current-shared-key"));
      expect(fs.readFileSync(path.join(agentDir, "models.json"))).toEqual(source);
    },
  );

  it.each(["main", "helper"])(
    "warns about an unproven %s models-json shadow without changing credentials",
    async (agentId) => {
      const state = createState();
      const agentDir = path.join(state.stateDir, "agents", agentId, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const shared = createAuthProfileStoreFixture({ "custom:default": credential("shared-key") });
      const local = createAuthProfileStoreFixture({
        "custom:models-json": credential("local-key"),
      });
      await persistAuthProfileBatch({
        stateDir: state.stateDir,
        profiles: [{ profileId: "custom:default", credential: shared.profiles["custom:default"] }],
      });
      saveAuthProfileStore(local, agentDir);

      const result = await state.migrate({ agents: agentConfig(state, agentId, agentDir) });

      expect(result).toMatchObject({ migrated: 0, removed: 0 });
      expect(result.warnings.join("\n")).toContain(
        `openclaw models auth logout 'custom:models-json' --agent '${agentId}' --yes`,
      );
      expect(loadPersistedAuthProfileStore(agentDir)).toEqual(local);
      expect(loadPersistedSharedAuthProfileStore(state.env)).toEqual(shared);
    },
  );

  it("refuses malformed UTF-8 root catalog credentials while importing healthy config", async () => {
    const state = createState();
    const catalogPath = path.join(state.agentDir, "models.json");
    const source = Buffer.from(JSON.stringify({ providers: { root: provider("broken-key") } }));
    source[source.indexOf("broken-key")] = 0xff;
    fs.writeFileSync(catalogPath, source);

    const result = await state.migrate(configWithKey("configured-key", "configured"));

    expect(result).toMatchObject({ detected: 1, migrated: 1 });
    expect(result.warnings.join("\n")).toContain("UTF-8");
    expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles).toEqual({
      "configured:default": { type: "api_key", provider: "configured", key: "configured-key" },
    });
    expect(fs.readFileSync(catalogPath)).toEqual(source);
  });
  it("copies config, root, and plugin catalog keys before runtime retires plaintext", async () => {
    const state = createState();
    const { agentDir } = state;
    const cfg = configWithKey("configured-secret", "configured");
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

    const first = await state.migrate(cfg);

    expect(first).toMatchObject({ detected: 3, migrated: 3, warnings: [] });
    expect(cfg.models?.providers?.configured?.apiKey).toBe("configured-secret");
    const migratedProfiles = loadPersistedSharedAuthProfileStore(state.env)?.profiles ?? {};
    expect(migratedProfiles).toMatchObject({
      "configured:default": createApiKeyCredential("configured", "configured-secret"),
      "root:default": { type: "api_key", provider: "root", key: "root-secret" },
      "plugin:default": { type: "api_key", provider: "plugin", key: "plugin-secret" },
    });
    expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")).toBe(rootContents);
    const pluginCatalog = loadPersistedPluginModelCatalogsReadOnly(agentDir)[0];
    expect(pluginCatalog?.contents).toBe(pluginContents);

    const second = await state.migrate(cfg);
    expect(second).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
  });

  it("preserves custom provider env references and removes profiles containing their markers", async () => {
    const state = createState();
    const cfg = configWithKey("${CUSTOM_PROVIDER_KEY}");
    writeCatalog(state.agentDir, "CUSTOM_PROVIDER_KEY");

    const first = await state.migrate(cfg);

    expect(first).toEqual(migrationResult());
    expect(loadPersistedSharedAuthProfileStore(state.env)).toBeNull();

    saveAuthProfileStore(markerStore(), state.agentDir);

    const repaired = await state.migrate(cfg);

    expect(repaired).toEqual(migrationResult(0, 0, 2));
    expect(loadPersistedSharedAuthProfileStore(state.env)).toEqual({ version: 1, profiles: {} });
  });

  it.each(["main", "helper"])(
    "preserves a %s credential replaced while the repair prompt is pending",
    async (agentId) => {
      const state = createState();
      const agentDir = path.join(state.stateDir, "agents", agentId, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const cfg: OpenClawConfig = {
        agents: agentConfig(state, agentId, agentDir),
        ...configWithKey("${CUSTOM_PROVIDER_KEY}"),
      };
      const store: AuthProfileStore = {
        ...markerStore("CUSTOM_PROVIDER_KEY", "$CUSTOM_PROVIDER_KEY"),
        usageStats: { "custom:default": { lastUsed: 123, errorCount: 0 } },
      };
      saveAuthProfileStore(store, agentDir);
      const params = migrationParams(state, cfg);
      repairDuringPrompt(params, () => {
        store.profiles["custom:default"] = credential("replacement-secret");
        saveAuthProfileStore(store, agentDir);
      });

      const result = await maybeMigrateModelCatalogCredentials(params);

      expect(result).toEqual(migrationResult(0, 0, 1));
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
    const cfg = configWithKey("${CUSTOM_PROVIDER_KEY}");
    writeCatalog(state.agentDir, "stale-provider-key");

    expect(await state.migrate(cfg)).toEqual(migrationResult());
    expect(loadPersistedSharedAuthProfileStore(state.env)).toBeNull();
  });

  it.each([
    { type: "api_key", agentId: "main", duringPrompt: false, local: false },
    { type: "token", agentId: "helper", duringPrompt: false, local: false },
    { type: "api_key", agentId: "helper", duringPrompt: true, local: false },
    { type: "token", agentId: "main", duringPrompt: true, local: false },
    { type: "api_key", agentId: "helper", duringPrompt: false, local: true },
  ] as const)(
    "keeps a $type SecretRef authoritative for $agentId (during prompt: $duringPrompt, local: $local)",
    async ({ type, agentId, duringPrompt, local }) => {
      const state = createState();
      const agentDir = path.join(state.stateDir, "agents", agentId, "agent");
      fs.mkdirSync(agentDir, { recursive: true });
      const ref = { source: "env" as const, provider: "default", id: "FIXTURE_CUSTOM_KEY" };
      const canonical =
        type === "api_key"
          ? { type, provider: "custom", keyRef: ref }
          : { type, provider: "custom", tokenRef: ref };
      const store = createAuthProfileStoreFixture({ "custom:default": canonical });
      const installReference = () => saveAuthProfileStore(store, local ? agentDir : state.agentDir);
      if (!duringPrompt) {
        installReference();
      }
      writeCatalog(agentDir, "stale-catalog-key");
      const params = migrationParams(state, {
        agents: agentConfig(state, agentId, agentDir),
      });
      if (duringPrompt) {
        repairDuringPrompt(params, installReference);
      }

      expect(await maybeMigrateModelCatalogCredentials(params)).toEqual(
        migrationResult(duringPrompt ? 1 : 0),
      );
      if (local) {
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toEqual(store.profiles);
        expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles ?? {}).toEqual({});
      } else {
        expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles).toEqual(store.profiles);
      }
      if (agentId !== "main" && !local) {
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles ?? {}).toEqual({});
      }
    },
  );

  it("imports an explicit config key beside an expired token reference without copying its catalog", async () => {
    const state = createState();
    const canonical = {
      type: "token" as const,
      provider: "custom",
      tokenRef: { source: "env" as const, provider: "default", id: "FIXTURE_CUSTOM_KEY" },
      expires: 1,
    };
    saveAuthProfileStore(
      createAuthProfileStoreFixture({ "custom:old": canonical }),
      state.agentDir,
    );
    writeCatalog(state.agentDir, "stale-catalog-key");

    expect(await state.migrate(configWithKey("fresh-config-key"))).toEqual(migrationResult(1, 1));
    expect(loadPersistedSharedAuthProfileStore(state.env)?.profiles).toEqual({
      "custom:old": canonical,
      "custom:default": { type: "api_key", provider: "custom", key: "fresh-config-key" },
    });
  });

  it("refuses to overwrite an unreadable canonical auth store", async () => {
    const state = createState();
    const { agentDir } = state;
    const unreadable = { version: 1, profiles: "not-a-profile-map" };
    writePersistedAuthProfileStoreRaw(unreadable, agentDir);
    const rootContents = `${JSON.stringify({ providers: { custom: provider("catalog-secret") } })}\n`;
    fs.writeFileSync(path.join(agentDir, "models.json"), rootContents);

    const result = await state.migrate();

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
        "custom:default": credential("configured-secret"),
      }),
      state.agentDir,
    );
    saveAuthProfileStore(
      createAuthProfileStoreFixture({
        "custom:default": credential("child-secret"),
      }),
      childAgentDir,
    );

    const result = await state.migrate(configWithKey("configured-secret"));

    expect(result).toMatchObject({ detected: 1, migrated: 1, warnings: [] });
    expect(
      loadPersistedAuthProfileStore(state.agentDir)?.profiles["custom:models-json"],
    ).toMatchObject({ key: "configured-secret" });
    expect(loadPersistedAuthProfileStore(childAgentDir)?.profiles["custom:default"]).toMatchObject({
      key: "child-secret",
    });
  });
});
