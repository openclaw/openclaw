import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it as baseIt, vi } from "vitest";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { loadAgentRuntimePluginRegistryHandle } from "../agents/runtime-plugins.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayPlugins } from "../gateway/server-plugins.js";
import { prepareGatewayPluginBootstrap } from "../gateway/server-startup-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import {
  resolvePluginCapabilityProvider,
  resolvePluginCapabilityProviders,
} from "./capability-provider-runtime.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import * as discovery from "./discovery.js";
import { writeJson } from "./generated-plugin-test-helpers.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
import { projectInstalledPluginIndexPolicy } from "./installed-plugin-index.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  writePlugin,
} from "./loader.test-fixtures.js";
import * as manifests from "./manifest-registry.js";
import { resetPluginCache } from "./plugin-cache.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";
import * as sdkAlias from "./sdk-alias.js";

const id = "fixture-speech";
const log = { info() {}, warn() {}, error() {}, debug() {} };
const voiceKeys = [
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
] as const;
const contracts = Object.fromEntries(voiceKeys.map((key) => [key, [id]]));
type SpeechFixture = ReturnType<typeof createSpeechFixture>;

vi.mock("../agents/subagents/registry/subagent-registry.js", () => ({
  initSubagentRegistry() {},
}));

async function withSpeechFixture(
  run: (fixture: SpeechFixture) => void | Promise<void>,
  registration = "",
) {
  const fixture = createSpeechFixture(registration);
  return withEnvAsync(
    {
      OPENCLAW_STATE_DIR: path.join(fixture.root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(fixture.root, "extensions"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
    },
    async () => run(fixture),
  );
}

function createSpeechFixture(registration = "") {
  const root = fs.realpathSync(makePluginLoaderTempDir());
  const workspaceDir = path.join(root, "workspace");
  mkdirSafe(workspaceDir);
  const body = (label: string) => `let registrations = 0;
export default { id: "${id}", register(api) {
  ${registration}
  const label = "${label}:" + ++registrations;
  api.registerSpeechProvider({ id: "${id}", label,
    isConfigured: () => false, synthesize: async () => { throw new Error("synthesis is not catalog discovery"); } });
  api.registerRealtimeTranscriptionProvider({ id: "${id}", label,
    isConfigured: () => false, createSession: () => { throw new Error("session creation is not catalog discovery"); } });
  api.registerRealtimeVoiceProvider({ id: "${id}", label,
    isConfigured: () => false, createBridge: () => { throw new Error("bridge creation is not catalog discovery"); } });
} };`;
  const plugin = writePlugin({
    id,
    dir: path.join(root, "extensions", id),
    filename: "index.ts",
    body: body("source"),
  });
  const manifestPath = path.join(plugin.dir, "openclaw.plugin.json");
  writeJson(manifestPath, { id, configSchema: EMPTY_PLUGIN_SCHEMA, contracts });
  const writeEntryPackage = (dir: string, entry: string) =>
    writeJson(path.join(dir, "package.json"), { openclaw: { extensions: [`./${entry}`] } });
  writeEntryPackage(plugin.dir, "index.ts");
  const builtDir = path.join(root, "dist", "extensions", id);
  mkdirSafe(builtDir);
  fs.writeFileSync(path.join(builtDir, "index.js"), body("built"));
  // Artifact selection follows the entry format declared by emitted package metadata.
  writeEntryPackage(builtDir, "index.js");
  const seed = writePlugin({
    id: "fixture-seed",
    dir: path.join(root, "extensions", "fixture-seed"),
    filename: "index.cjs",
    body: 'module.exports = { id: "fixture-seed", register() {} };',
  });
  writeEntryPackage(seed.dir, "index.cjs");
  const config: OpenClawConfig = {
    agents: { defaults: { workspace: workspaceDir } },
    plugins: { enabled: false },
  };
  const providers = (key: (typeof voiceKeys)[number] = "speechProviders") =>
    resolvePluginCapabilityProviders({ key, cfg: config });
  const provider = (providerId = id, key: (typeof voiceKeys)[number] = "speechProviders") =>
    resolvePluginCapabilityProvider({ key, cfg: config, providerId });
  const labels = (key?: (typeof voiceKeys)[number]) => providers(key).map((entry) => entry.label);
  return { root, workspaceDir, config, providers, provider, labels };
}

function publishMetadata(fixture: SpeechFixture) {
  const snapshot = prepareMetadata(fixture);
  setCurrentPluginMetadataSnapshot(snapshot, fixture);
  return snapshot;
}

function prepareMetadata(fixture: SpeechFixture) {
  return createPluginMetadataSnapshot({
    config: fixture.config,
    workspaceDir: fixture.workspaceDir,
    manifestRegistry: manifests.loadPluginManifestRegistryCore({ config: fixture.config }),
  });
}

function declareCapabilityCatalog(
  fixture: SpeechFixture,
  keys: readonly (typeof voiceKeys)[number][] = voiceKeys,
) {
  const pluginDir = path.join(fixture.root, "extensions", id);
  patchManifest(pluginDir, { capabilityCatalogEntry: "./capability-catalog.ts" });
  const runtimeImported = path.join(fixture.root, "runtime-imported");
  for (const [dir, extension, label] of [
    [pluginDir, "ts", "source"],
    [path.join(fixture.root, "dist", "extensions", id), "js", "built"],
  ] as const) {
    const entry = path.join(dir, `index.${extension}`);
    fs.writeFileSync(entry, `import "./runtime-only.cjs";\n${fs.readFileSync(entry, "utf8")}`);
    fs.writeFileSync(
      path.join(dir, "runtime-only.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(runtimeImported)}, "loaded");`,
    );
    fs.writeFileSync(
      path.join(dir, `capability-catalog.${extension}`),
      `const provider = {
  id: "${id}", label: "${label}:catalog", aliases: ["fixture-alias"],
  resolveConfig: ({ rawConfig }) => rawConfig,
  isConfigured: ({ providerConfig }) => providerConfig.ready === true,
  synthesize: async () => { throw new Error("not synthesis"); },
  createSession: () => { throw new Error("not a session"); },
  createBridge: () => { throw new Error("not a bridge"); }
};
Object.defineProperty(provider, Symbol.for("fixture.internal"), { value: { ready: () => true } });
export default Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, [provider, { ...provider, id: "fixture-secondary", aliases: [] }]]));`,
    );
  }
  return { pluginDir, runtimeImported };
}

async function loadGatewayGeneration(
  fixture: SpeechFixture,
  workspaceDir = fixture.workspaceDir,
  pluginIds: string[] = [],
  pluginMetadataSnapshot?: ReturnType<typeof publishMetadata>,
  extra: Partial<Parameters<typeof loadGatewayPlugins>[0]> = {},
) {
  const { pluginRegistry } = await loadGatewayPlugins({
    loadIntent: "startup",
    cfg: fixture.config,
    activationSourceConfig: fixture.config,
    autoEnabledReasons: {},
    workspaceDir,
    pluginIds,
    pluginMetadataSnapshot,
    baseMethods: [],
    ...extra,
  });
  setActivePluginRegistry(pluginRegistry);
  return pluginRegistry;
}

async function withGateway(fixture: SpeechFixture, run: () => void) {
  publishMetadata(fixture);
  const registry = await loadGatewayGeneration(fixture);
  return withPluginRuntimeRegistryScope(registry, run);
}

async function withCatalogMutation(
  fixture: SpeechFixture,
  mutation: { body: string } | { entry: unknown },
  run: () => void,
) {
  const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
  if ("body" in mutation) {
    fs.writeFileSync(
      path.join(fixture.root, "dist", "extensions", id, "capability-catalog.js"),
      mutation.body,
    );
  } else {
    patchManifest(pluginDir, { capabilityCatalogEntry: mutation.entry });
  }
  await withGateway(fixture, () => {
    run();
    expect(fs.existsSync(runtimeImported)).toBe(false);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
});
afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
  vi.doUnmock("../agents/subagents/registry/subagent-registry.js");
  vi.resetModules();
});

function patchManifest(dir: string, patch: object) {
  const file = path.join(dir, "openclaw.plugin.json");
  writeJson(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch });
}

const it = baseIt.extend<{ speech: SpeechFixture }>({
  speech: async ({ task: _task }, use) => withSpeechFixture(use),
});

describe("capability loading from a Gateway generation", () => {
  it.each(["agent", "gateway", "capability", "restricted"] as const)(
    "keeps native model policy outside broad registration runtime at the %s root",
    async (root) => {
      const registration = `
        const modelConfig = api.runtime.modelConfig;
        const selected = modelConfig.resolveDefaultModelForAgent({ cfg: api.config, manifestPlugins: [] });
        const allowed = modelConfig.resolveAllowedModelRef({ cfg: api.config, catalog: [], raw: "${id}/model", defaultProvider: "${id}", manifestPlugins: [] });
        const denied = modelConfig.resolveAllowedModelRef({ cfg: api.config, catalog: [], raw: "${id}/blocked", defaultProvider: "${id}", manifestPlugins: [] });
        if (selected.provider !== "${id}" || selected.model !== "model" || allowed.key !== "${id}/model" || denied.error !== "model not allowed: ${id}/blocked") {
          throw new Error("native model selection policy failed");
        }
        const auth = api.runtime.modelAuth;
        const provider = auth.resolveProviderIdForAuth(" ${id} ", { metadataSnapshot: { plugins: [] } });
        const empty = auth.ensureAuthProfileStore(api.config.agents.entries.main.agentDir, {
          readOnly: true, allowKeychainPrompt: false, config: api.config,
        });
        const store = { version: 1, profiles: { fixture: { type: "api_key", provider, key: "fixture-key" } } };
        const profiles = auth.listProfilesForProvider(store, provider);
        const order = auth.resolveAuthProfileOrder({ cfg: api.config, store, provider, authAliasLookupParams: { metadataSnapshot: { plugins: [] } } });
        if (Object.keys(empty.profiles).length !== 0 || profiles.join() !== "fixture" || order.join() !== "fixture" || !auth.isProviderApiKeyConfigured({ cfg: api.config, provider })) {
          throw new Error("native auth policy failed");
        }
        for (const key of ["modelAuth", "modelConfig"]) {
          if (Object.getOwnPropertyDescriptor(api.runtime, key).set !== undefined) {
            throw new Error("native policy facet must remain getter-only");
          }
        }
        if (${root === "restricted"} && (Object.hasOwn(api.runtime, "agent") || Object.hasOwn(api.runtime, "subagent"))) {
          throw new Error("restricted registration acquired execution authority");
        }
      `;
      await withSpeechFixture(async (fixture) => {
        const agentDirPath = path.join(fixture.root, "state", "agents", "main", "agent");
        mkdirSafe(agentDirPath);
        const agentDir = fs.realpathSync(agentDirPath);
        expect(path.isAbsolute(agentDir)).toBe(true);
        expect(path.relative(fixture.root, agentDir)).toBe(
          path.join("state", "agents", "main", "agent"),
        );
        // Verify the inherited shared owner too; never mask an ambient relocation outside the fixture.
        expect(resolveSharedMainAuthAgentDir()).toBe(agentDir);
        fixture.config.plugins = { entries: { [id]: { enabled: true } } };
        fixture.config.agents!.entries = { main: { agentDir } };
        fixture.config.agents!.defaults!.model = `${id}/model`;
        fixture.config.agents!.defaults!.modelPolicy = { allow: [`${id}/model`] };
        fixture.config.models = {
          providers: {
            [id]: { baseUrl: "https://provider.example/v1", models: [], apiKey: "fixture-key" },
          },
        };
        const metadataSnapshot = publishMetadata(fixture);
        const broadRuntime = vi
          .spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics")
          .mockImplementation(() => {
            throw new Error("native root loaded broad registration runtime");
          });
        let providers;
        if (root === "capability") {
          setActivePluginRegistry(createEmptyPluginRegistry());
          providers = fixture.providers();
        } else {
          const registry =
            root === "agent"
              ? loadAgentRuntimePluginRegistryHandle({
                  config: fixture.config,
                  workspaceDir: fixture.workspaceDir,
                  basePluginIds: [id],
                  selections: [],
                  metadataSnapshot,
                })
              : root === "gateway"
                ? await loadGatewayGeneration(fixture, fixture.workspaceDir, [id], metadataSnapshot)
                : loadBundledCapabilityRuntimeRegistry({
                    config: fixture.config,
                    workspaceDir: fixture.workspaceDir,
                    pluginIds: [id],
                    manifestRegistry: metadataSnapshot.manifestRegistry,
                  });
          expect(registry.plugins).toContainEqual(
            expect.objectContaining({ id, status: "loaded" }),
          );
          providers = registry.speechProviders.map((entry) => entry.provider);
        }
        expect(providers.map((provider) => provider.id)).toEqual([id]);
        expect(broadRuntime).not.toHaveBeenCalled();
      }, registration);
    },
  );

  it("loads a cold catalog without evaluating the full entry", async ({ speech: fixture }) => {
    fixture.config.plugins = { enabled: true };
    const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
    fs.rmSync(path.join(fixture.root, "dist"), { recursive: true, force: true });
    fs.appendFileSync(
      path.join(pluginDir, "runtime-only.cjs"),
      '\nthrow new Error("catalog imported forbidden full runtime");',
    );
    await withGateway(fixture, () => {
      const providers = fixture.providers();
      expect(fs.existsSync(runtimeImported)).toBe(false);
      expect(providers.map((provider) => provider.id)).toEqual([id, "fixture-secondary"]);
      const provider = fixture.provider("fixture-alias");
      expect(provider).toBe(providers[0]);
      expect(fixture.providers()[0]).toBe(provider);
      expect(provider?.label).toBe("source:catalog");
      const providerContext = { cfg: fixture.config, timeoutMs: 1000 };
      const ready = { ready: true };
      expect(provider?.resolveConfig?.({ ...providerContext, rawConfig: ready })).toEqual({
        ready: true,
      });
      expect(provider?.isConfigured({ ...providerContext, providerConfig: { ready: true } })).toBe(
        true,
      );
      expect(Reflect.get(provider!, Symbol.for("fixture.internal")).ready()).toBe(true);
    });
  });

  it("loads only the requested built catalog owners", async ({ speech: fixture }) => {
    fixture.config.plugins = { enabled: true };
    fixture.config.tts = { provider: id, providers: { "fixture-secondary": {} } };
    const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
    patchManifest(pluginDir, {
      contracts: { ...contracts, speechProviders: [id, "fixture-secondary"] },
    });
    const unrelatedDir = path.join(fixture.root, "extensions", "fixture-seed");
    patchManifest(unrelatedDir, {
      contracts: { speechProviders: ["fixture-unrequested"] },
      capabilityCatalogEntry: "./capability-catalog.cjs",
    });
    fs.writeFileSync(
      path.join(unrelatedDir, "capability-catalog.cjs"),
      'throw new Error("unrequested catalog must not be evaluated");',
    );
    await withGateway(fixture, () => {
      const providers = fixture.providers();
      expect(providers.map(({ id: providerId, label }) => ({ id: providerId, label }))).toEqual([
        { id, label: "built:catalog" },
        { id: "fixture-secondary", label: "built:catalog" },
      ]);
      expect(fs.existsSync(runtimeImported)).toBe(false);
    });
  });

  it("uses register() for an uncovered speech family", async ({ speech: fixture }) => {
    const key = "speechProviders";
    fixture.config.plugins = { enabled: true };
    const { runtimeImported } = declareCapabilityCatalog(
      fixture,
      voiceKeys.filter((family) => family !== key),
    );
    await withGateway(fixture, () => {
      expect(fixture.labels(key)).toEqual(["built:1"]);
      expect(fs.readFileSync(runtimeImported, "utf8")).toBe("loaded");
    });
  });

  it("uses built speech catalogs when plugins are globally disabled", async ({
    speech: fixture,
  }) => {
    const { runtimeImported } = declareCapabilityCatalog(fixture);
    await withGateway(fixture, () => {
      expect(fixture.labels()).toEqual(["built:catalog", "built:catalog"]);
      expect(fixture.providers("realtimeVoiceProviders")).toEqual([]);
      expect(fs.existsSync(runtimeImported)).toBe(false);
    });
  });

  it("prefers active runtime descriptors over catalogs", async ({ speech: fixture }) => {
    fixture.config.plugins = { enabled: true, entries: { [id]: { enabled: true } } };
    declareCapabilityCatalog(fixture);
    fs.writeFileSync(
      path.join(fixture.root, "dist", "extensions", id, "capability-catalog.js"),
      'throw new Error("active runtime must retain its bound descriptors");',
    );
    publishMetadata(fixture);
    const registry = await loadGatewayGeneration(fixture, fixture.workspaceDir, [id]);
    withPluginRuntimeRegistryScope(registry, () => {
      for (const key of voiceKeys) {
        const provider = registry[key][0]!.provider;
        expect(fixture.providers(key)).toEqual([provider]);
        expect(fixture.provider(id, key)).toBe(provider);
      }
    });
  });

  it("loads an installed override's own catalog", async ({ speech: fixture }) => {
    fixture.config.plugins = { enabled: true, allow: [id] };
    const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
    const installedDir = path.join(fixture.root, "installed", id);
    fs.cpSync(pluginDir, installedDir, { recursive: true });
    const catalogPath = path.join(installedDir, "capability-catalog.ts");
    fs.writeFileSync(
      catalogPath,
      fs.readFileSync(catalogPath, "utf8").replace("source:catalog", "installed:catalog"),
    );
    const installed = {
      [id]: { source: "path" as const, installPath: installedDir, sourcePath: installedDir },
    };
    const discovered = discovery.discoverOpenClawPlugins({ installRecords: installed });
    const snapshot = createPluginMetadataSnapshot({
      config: fixture.config,
      workspaceDir: fixture.workspaceDir,
      manifestRegistry: manifests.loadPluginManifestRegistryCore({
        config: fixture.config,
        installRecords: installed,
        discovery: discovered,
      }),
    });
    snapshot.index.installRecords = installed;
    snapshot.index.plugins = projectInstalledPluginIndexPolicy({
      plugins: buildInstalledPluginIndexRecords({
        registry: snapshot.manifestRegistry,
        candidates: discovered.candidates,
        installRecords: installed,
        diagnostics: [],
      }),
      config: fixture.config,
      env: process.env,
    });
    expect(snapshot.byPluginId.get(id)?.rootDir).toBe(installedDir);
    setCurrentPluginMetadataSnapshot(snapshot, fixture);
    const registry = await loadGatewayGeneration(fixture);
    withPluginRuntimeRegistryScope(registry, () => {
      for (const key of voiceKeys) {
        expect(fixture.provider("fixture-alias", key)?.label).toBe("installed:catalog");
      }
    });
    expect(fs.existsSync(runtimeImported)).toBe(false);
  });

  it("recreates providers, retaining process-loaded catalog factories", async ({
    speech: fixture,
  }) => {
    fixture.config.plugins = { enabled: true };
    const { pluginDir, runtimeImported } = declareCapabilityCatalog(fixture);
    fs.rmSync(path.join(fixture.root, "dist"), { recursive: true, force: true });
    const catalogPath = path.join(pluginDir, "capability-catalog.ts");
    const body = `export default () => {\n${fs
      .readFileSync(catalogPath, "utf8")
      .replace("export default Object.fromEntries", "return Object.fromEntries")}\n};`;
    fs.writeFileSync(catalogPath, body);
    publishMetadata(fixture);
    const previous = await loadGatewayGeneration(fixture);
    const first = withPluginRuntimeRegistryScope(previous, () => fixture.providers()[0]);
    fs.writeFileSync(catalogPath, body.replace("source:catalog", "replacement:catalog"));
    withPluginRuntimeRegistryScope(previous, () => {
      expect(fixture.providers()[0]).toBe(first);
      expect(fixture.providers("realtimeVoiceProviders")[0]).toBe(first);
    });
    resetPluginCache();
    publishMetadata(fixture);
    const current = await loadGatewayGeneration(fixture);
    withPluginRuntimeRegistryScope(current, () => {
      const replacement = fixture.providers()[0];
      expect(replacement).not.toBe(first);
      expect(replacement?.label).toBe("source:catalog");
    });
    expect(fs.existsSync(runtimeImported)).toBe(false);
  });

  it.for(["export default", "module.exports ="])(
    "treats an explicitly empty family as authoritative (%s)",
    async (declaration, { speech: fixture }) => {
      await withCatalogMutation(
        fixture,
        { body: `${declaration} { speechProviders: [] };` },
        () => {
          expect(fixture.providers()).toEqual([]);
          expect(fixture.provider("fixture-alias")).toBeUndefined();
        },
      );
    },
  );

  it.for([
    'throw new Error("broken catalog");',
    "export default { speechProviders: [{}] };",
    "export default { speechProvider: [] };",
    "export default async () => ({ speechProviders: [] });",
  ])(
    "reports broken catalogs without importing the full entry: %s",
    async (body, { speech: fixture }) => {
      await withCatalogMutation(fixture, { body }, () => {
        expect(() => fixture.providers()).toThrow(
          /capabilityCatalogEntry failed.*Repair the declared entry/,
        );
      });
    },
  );

  it.for(["../outside.ts", "", 7])(
    "rejects invalid catalog entry %j",
    async (entry, { speech: fixture }) => {
      await withCatalogMutation(fixture, { entry }, () => {
        expect(() => fixture.providers()).toThrow(/capabilityCatalogEntry failed/);
      });
    },
  );

  it.for(["speechProviders", "realtimeVoiceProviders"] as const)(
    "uses prepared artifacts for cold %s discovery",
    async (key, { speech: fixture }) => {
      fixture.config.plugins = { enabled: key !== "speechProviders" };
      const snapshot = publishMetadata(fixture);
      const bootstrap = await prepareGatewayPluginBootstrap({
        cfgAtStart: fixture.config,
        pluginMetadataSnapshot: snapshot,
        minimalTestGateway: true,
        log,
      });
      setCurrentPluginMetadataSnapshot(bootstrap.pluginMetadataSnapshot, fixture);
      const discover = vi.spyOn(discovery, "discoverOpenClawPlugins");
      const readManifests = vi.spyOn(manifests, "loadPluginManifestRegistryCore");
      withPluginRuntimeRegistryScope(bootstrap.pluginRegistry, () => {
        const providers = fixture.providers(key);
        expect(providers.map((provider) => provider.label)).toEqual(["built:1"]);
        expect(fixture.provider(id, key)).toBe(providers[0]);
      });
      expect(discover).not.toHaveBeenCalled();
      expect(readManifests).not.toHaveBeenCalled();
      expect(bootstrap.pluginRegistry.plugins).toEqual([]);
    },
  );

  it("extends populated registries with built speech providers", async ({ speech: fixture }) => {
    fixture.config.plugins = { enabled: true, entries: { "fixture-seed": { enabled: true } } };
    const snapshot = publishMetadata(fixture);
    const startupSnapshot = createPluginMetadataSnapshot({
      config: fixture.config,
      workspaceDir: fixture.workspaceDir,
      manifestRegistry: {
        plugins: snapshot.plugins.filter((plugin) => plugin.id === "fixture-seed"),
        diagnostics: [],
      },
    });
    const registry = await loadGatewayGeneration(fixture, fixture.workspaceDir, [], undefined, {
      pluginIds: undefined,
      pluginLookUpTable: {
        ...startupSnapshot,
        pluginIds: ["fixture-seed"],
        startup: { pluginIds: ["fixture-seed"], channelPluginIds: [] },
        workerProviderIds: [],
        metrics: { ...startupSnapshot.metrics, startupPlanMs: 0, startupPluginCount: 1 },
      },
    });
    expect(getPluginRuntimeLoadContext(registry)?.metadataSnapshot).toBe(snapshot);
    expect(registry.plugins).toContainEqual(
      expect.objectContaining({ id: "fixture-seed", status: "loaded" }),
    );
    withPluginRuntimeRegistryScope(registry, () => {
      expect(fixture.labels()).toEqual(["built:1"]);
    });
  });

  it("keeps request context separate from the active registry", async ({ speech: fixture }) => {
    declareCapabilityCatalog(fixture);
    publishMetadata(fixture);
    const registry = await loadGatewayGeneration(fixture);
    const other = loadOpenClawPlugins({
      config: { ...fixture.config, plugins: { entries: { [id]: { enabled: true } } } },
      onlyPluginIds: [id],
    });
    expect(other.speechProviders[0]?.provider.label).toBe("source:1");
    withPluginRuntimeRegistryScope(registry, () => {
      expect(fixture.labels()).toEqual(["built:catalog", "built:catalog"]);
    });
    expect(getActivePluginRegistry()).toBe(other);
  });

  it("does not borrow another workspace's artifact preference", async ({ speech: fixture }) => {
    declareCapabilityCatalog(fixture);
    publishMetadata(fixture);
    const registry = await loadGatewayGeneration(
      fixture,
      path.join(fixture.root, "other-workspace"),
    );
    withPluginRuntimeRegistryScope(registry, () => {
      expect(fixture.labels()).toEqual(["source:catalog", "source:catalog"]);
    });
  });

  it("does not borrow a replaced registry generation", async ({ speech: fixture }) => {
    publishMetadata(fixture);
    const previous = await loadGatewayGeneration(fixture);
    const nextSnapshot = prepareMetadata(fixture);
    // Reload prepares the replacement before publishing its metadata generation.
    const current = await loadGatewayGeneration(fixture, fixture.workspaceDir, [], nextSnapshot);
    setCurrentPluginMetadataSnapshot(nextSnapshot, fixture);
    withPluginRuntimeRegistryScope(previous, () => {
      expect(fixture.labels()).toEqual(["source:1"]);
    });
    withPluginRuntimeRegistryScope(current, () => {
      expect(fixture.labels()).toEqual(["built:1"]);
    });
  });

  it.for([{ deny: [id] }, { entries: { [id]: { enabled: false } } }])(
    "preserves explicit speech owner denial: %j",
    async (policy, { speech: fixture }) => {
      fixture.config.plugins = { enabled: false, ...policy };
      const { runtimeImported } = declareCapabilityCatalog(fixture);
      await withGateway(fixture, () => {
        expect(fixture.providers()).toEqual([]);
        expect(fs.existsSync(runtimeImported)).toBe(false);
      });
    },
  );
});
