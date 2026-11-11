import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ModelCatalogProvider } from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { materializePluginAutoEnableCandidates } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayPlugins } from "../gateway/server-plugins.js";
import { resolveGatewayStartupPluginPlanFromRegistry } from "./gateway-startup-plugin-plan.js";
import { collectConfiguredAgentModelProviderIds } from "./gateway-startup-plugin-providers.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { getPluginLoaderCacheState } from "./registry-lifecycle.js";
import {
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "./runtime.js";

function createManifestRegistry(
  plugins: Array<Pick<PluginManifestRecord, "id"> & Partial<PluginManifestRecord>>,
): PluginManifestRegistry {
  return {
    plugins: plugins.map((plugin) =>
      createPluginManifestRecordFixture({ providers: [plugin.id], ...plugin }),
    ),
    diagnostics: [],
  };
}

function writeFixture(root: string, id: string, files: Record<string, string | object>) {
  const dir = path.join(root, id);
  mkdirSync(dir);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  return dir;
}
const configSchema = { type: "object", additionalProperties: false };

function catalog(id: string, provider: ModelCatalogProvider) {
  return { id, modelCatalog: { providers: { [id]: provider } } };
}

function loadBundledManifest(pluginId: string) {
  const result = loadPluginManifest(
    fileURLToPath(new URL(`../../extensions/${pluginId}/`, import.meta.url)),
  );
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.manifest;
}
const acpxManifest = loadBundledManifest("acpx");
const codexManifest = loadBundledManifest("codex");
type StartupPlugin = Pick<
  PluginManifestRecord,
  "id" | "enabledByDefault" | "activation" | "contracts"
>;
const startupRegistry = (plugin: StartupPlugin) =>
  createManifestRegistry([
    {
      rootDir: `/fixture/${plugin.id}`,
      source: `/fixture/${plugin.id}/index.ts`,
      providers: [],
      ...plugin,
    },
  ]);

function plan(
  activationSourceConfig: OpenClawConfig,
  registry: PluginManifestRegistry,
  candidates: Parameters<typeof materializePluginAutoEnableCandidates>[0]["candidates"],
) {
  const { config } = materializePluginAutoEnableCandidates({
    config: activationSourceConfig,
    candidates,
    env: {},
    manifestRegistry: registry,
  });
  return resolveGatewayStartupPluginPlanFromRegistry({
    config,
    activationSourceConfig,
    env: {},
    index: createInstalledPluginIndexFixture(registry),
    manifestRegistry: registry,
  }).pluginIds;
}

describe("auto-enabled plugin startup", () => {
  const manifestRegistry = startupRegistry(acpxManifest);
  it.each<[string, OpenClawConfig["plugins"], boolean]>([
    ["without a policy", undefined, true],
    ["excluded from allowlist", { allow: ["other"] }, false],
    ["included in allowlist", { allow: ["other", "acpx"] }, true],
    ["denied", { deny: ["acpx"] }, false],
    ["explicitly disabled", { entries: { acpx: { enabled: false } } }, false],
  ])("plans ACP %s", (_name, plugins, enabled) => {
    const config = { acp: { enabled: true }, plugins };
    const candidates = [{ pluginId: "acpx", kind: "setup-auto-enable" as const, reason: "ACP" }];
    expect(plan(config, manifestRegistry, candidates)).toEqual(enabled ? ["acpx"] : []);
  });
  it.each([undefined, false])("starts default-enabled ACP with enabled=%s", (enabled) => {
    const config = enabled === undefined ? {} : { acp: { enabled } };
    expect(plan(config, manifestRegistry, [])).toEqual(["acpx"]);
  });
  const harnessCandidate = (pluginId: string) => [
    {
      pluginId,
      kind: "agent-harness-runtime-configured" as const,
      runtime: "codex",
    },
  ];
  it.each([
    [false, true],
    [true, false],
  ])("rejects ineligible startup: default=%s trigger=%s", (enabledByDefault, onStartup) => {
    const plugin = { id: "optional", enabledByDefault, activation: { onStartup } };
    expect(plan({}, startupRegistry(plugin), harnessCandidate(plugin.id))).toEqual([]);
  });
  it("starts an enabled Codex tool owner without a configured harness", () => {
    expect(plan({}, startupRegistry(codexManifest), harnessCandidate("codex"))).toEqual(["codex"]);
  });
});

describe("configured Gateway model provider ownership", () => {
  it("does not inspect model catalogs when no agent model refs are configured", () => {
    const registry = createManifestRegistry([
      catalog("unused", {
        get models(): never {
          throw new Error("unconfigured catalog was inspected");
        },
      }),
    ]);

    expect(collectConfiguredAgentModelProviderIds({}, registry)).toEqual(new Set());
  });

  it("loads providers selected only by utility primary and fallback refs", () => {
    const registry = createManifestRegistry(
      ["primary", "backup", "agent-backup", "unused"].map((id) => ({ id })),
    );
    const config: OpenClawConfig = {
      agents: {
        defaults: { utilityModel: { primary: "primary/small", fallbacks: ["backup/small"] } },
        entries: { main: { utilityModel: { fallbacks: ["agent-backup/small"] } } },
      },
    };
    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(
      new Set(["primary", "backup", "agent-backup"]),
    );
  });

  it("does not normalize unrelated rows in a large catalog", () => {
    let unrelatedNormalizationReads = 0;
    const unrelatedModels = Array.from({ length: 10_000 }, (_, index) => ({
      id: `unrelated-${index}`,
      get name() {
        unrelatedNormalizationReads += 1;
        return `Unrelated ${index}`;
      },
    }));
    const registry = createManifestRegistry([
      catalog("selected", {
        api: "bedrock-converse-stream",
        models: [{ id: "requested" }, ...unrelatedModels],
      }),
      catalog("unrelated", { models: unrelatedModels }),
    ]);
    const config = {
      agents: { defaults: { model: "selected/requested" } },
    } as OpenClawConfig;

    expect(collectConfiguredAgentModelProviderIds(config, registry)).toEqual(new Set(["selected"]));
    expect(unrelatedNormalizationReads).toBe(0);
  });
});

describe("selected CLI backend Gateway startup", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  function startupRoot(prefix: string) {
    const root = tempDirs.make(prefix);
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    return root;
  }

  afterEach(() => {
    getPluginLoaderCacheState().clear();
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it("services queued I/O between registrations without publishing a partial registry", async () => {
    const root = startupRoot("openclaw-incremental-startup-");
    const ids = ["first", "second"];
    const paths = ids.map((id) =>
      writeFixture(root, id, {
        "openclaw.plugin.json": { id, configSchema },
        "index.cjs": `module.exports = { id: "${id}", register(api) {
          api.registerService({ id: "${id}", start() {} });
          process.emit("openclaw-test-incremental-startup", "${id}");
        } };`,
      }),
    );
    const events: string[] = [];
    const previous = getActivePluginRegistry();
    const observedRegistries: unknown[] = [];
    const onRegistration = (id: string) => {
      events.push(id);
      // This event-loop turn is the behavior under test, not an elapsed-time assertion.
      void nextTurn().then(() => {
        events.push("io");
        observedRegistries.push(getActivePluginRegistry());
      });
    };
    process.on("openclaw-test-incremental-startup", onRegistration);
    try {
      const loaded = await loadGatewayPlugins({
        cfg: { plugins: { allow: ids, load: { paths }, slots: { memory: "none" } } },
        pluginIds: ids,
        autoEnabledReasons: {},
        baseMethods: [],
        loadIntent: "startup",
      });
      try {
        expect(events).toEqual(["first", "io", "second", "io"]);
        expect(observedRegistries).toEqual([previous, previous]);
        expect(loaded.pluginRegistry.services.map(({ service }) => service.id)).toEqual(ids);
      } finally {
        loaded.retireGatewayRuntimeBindings();
        await disposePluginRegistryInstances(loaded.pluginRegistry);
      }
    } finally {
      process.off("openclaw-test-incremental-startup", onRegistration);
    }
  });

  it.each([
    { name: "provider API hint", apiLocation: "provider", backendOnly: false, fallback: false },
    { name: "model API hint", apiLocation: "model", backendOnly: false, fallback: false },
    { name: "backend-only fallback", apiLocation: "provider", backendOnly: true, fallback: true },
  ])("loadGatewayPlugins registers the executable with a $name", async (scenario) => {
    const root = startupRoot("openclaw-cli-startup-");
    const workspaceDir = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    mkdirSync(workspaceDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

    const owners = [
      {
        id: "selected-plugin",
        providers: scenario.backendOnly ? [] : ["selected-cli"],
        cliBackends: ["selected-cli"],
      },
      { id: "disabled-plugin", providers: ["disabled-cli"], cliBackends: ["disabled-cli"] },
      { id: "unused-plugin", providers: ["unused-cli"], cliBackends: ["unused-cli"] },
      { id: "http-plugin", providers: ["ordinary-http"], cliBackends: [] },
    ];
    const backendConfig = { command: process.execPath };
    const pluginPaths = owners.map((owner) =>
      writeFixture(root, owner.id, {
        "package.json": {
          name: owner.id,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        },
        "openclaw.plugin.json": {
          ...owner,
          activation: { onStartup: false },
          configSchema,
        },
        "index.cjs":
          owner.id === "selected-plugin"
            ? `module.exports = { id: "selected-plugin", register(api) {
              api.registerCliBackend({ id: "selected-cli", config: ${JSON.stringify(backendConfig)} });
            } };`
            : `throw new Error("Unexpected startup runtime: ${owner.id}");`,
      }),
    );
    const model = {
      id: "auto",
      name: "Auto",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8192,
    };
    function provider(baseUrl: string, apiLocation = "provider") {
      const api = { api: "openai-completions" as const };
      return {
        baseUrl,
        ...(apiLocation === "provider" ? api : {}),
        models: [{ ...model, ...(apiLocation === "model" ? api : {}) }],
      };
    }
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: scenario.fallback
            ? { primary: "ordinary-http/auto", fallbacks: ["selected-cli/auto"] }
            : { primary: "selected-cli/auto", fallbacks: ["ordinary-http/auto"] },
        },
        entries: { disabled: { model: "disabled-cli/auto" } },
      },
      models: {
        providers: {
          "selected-cli": provider("cli://selected", scenario.apiLocation),
          "disabled-cli": provider("cli://disabled"),
          "ordinary-http": provider("https://provider.invalid/v1"),
        },
      },
      plugins: {
        allow: owners.map((owner) => owner.id),
        load: { paths: pluginPaths },
        entries: Object.fromEntries(
          owners.map(({ id }) => [id, { enabled: id !== "disabled-plugin" }]),
        ),
        slots: { memory: "none" },
      },
    };

    writeFileSync(configPath, JSON.stringify(config));
    const loaded = await loadGatewayPlugins({
      cfg: config,
      workspaceDir,
      autoEnabledReasons: {},
      baseMethods: [],
      loadIntent: "startup",
    });
    const registry = loaded.pluginRegistry;
    try {
      expect(registry.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);
      expect(
        registry.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id),
      ).toEqual(["selected-plugin"]);
      expect(registry.cliBackends).toMatchObject([
        { pluginId: "selected-plugin", backend: { id: "selected-cli", config: backendConfig } },
      ]);
    } finally {
      loaded.retireGatewayRuntimeBindings();
      await disposePluginRegistryInstances(registry);
    }
  });
});
