import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { resolveConversationCapabilityProfile } from "../agents/conversation-capability-profile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createInstalledPluginIndexFixture } from "./gateway-startup.test-helpers.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord } from "./loader-records.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { resolvePluginTools } from "./tools.js";

afterEach(() => resetPluginRuntimeStateForTest());

it.each([false, true])(
  "keeps additive grants exact before optional plugin execution (granted: %s)",
  async (granted) => {
    const config: OpenClawConfig = {
      tools: { alsoAllow: ["web_search", ...(granted ? ["optional_tool"] : [])] },
      plugins: { enabled: true, slots: { memory: "none" } },
    };
    const manifest: PluginManifestRecord = {
      id: "optional-demo",
      source: "/fixture/optional-demo/index.js",
      rootDir: "/fixture/optional-demo",
      manifestPath: "/fixture/optional-demo/openclaw.plugin.json",
      origin: "bundled",
      enabledByDefault: true,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      contracts: { tools: ["optional_tool"] },
      toolMetadata: { optional_tool: { optional: true } },
    };
    const builder = createTestPluginRegistry(createPluginRuntime());
    const artifact = {
      source: manifest.source,
      rootDir: manifest.rootDir,
      origin: manifest.origin,
      preferBuiltPluginArtifacts: false,
    };
    const record = createPluginRecord({
      id: manifest.id,
      ...artifact,
      enabled: true,
      configSchema: true,
      contracts: manifest.contracts,
    });
    bindPluginRuntimeArtifactSelection(record, {
      preferBuiltPluginArtifacts: false,
      runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
    });
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config });
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: {},
    }));
    const factory = vi.fn(() => ({
      name: "optional_tool",
      label: "Optional fixture",
      description: "Synthetic optional plugin execution",
      parameters: Type.Object({}),
      execute,
    }));
    runPluginRegisterSyncInRegistry(
      (plugin) => plugin.registerTool(factory, { name: "optional_tool", optional: true }),
      api,
      builder.registry,
      manifest.id,
    );
    setActivePluginRegistry(builder.registry);
    const manifestRegistry = { plugins: [manifest], diagnostics: [] };
    const capability = resolveConversationCapabilityProfile({ config, agentId: "main" });
    const tools = resolvePluginTools({
      context: { config },
      toolAllowlist: capability.policy.explicitToolAllowlist,
      toolDenylist: capability.policy.explicitToolDenylist,
      preparedRuntime: {
        loadContext: {
          rawConfig: config,
          config,
          activationSourceConfig: config,
          autoEnabledReasons: {},
          workspaceDir: undefined,
          env: process.env,
          logger: { info() {}, warn() {}, error() {} },
          manifestRegistry,
        },
        metadataSnapshot: {
          index: createInstalledPluginIndexFixture(manifestRegistry),
          plugins: [manifest],
          byPluginId: new Map([[manifest.id, manifest]]),
        },
        registry: builder.registry,
      },
    });
    if (!granted) {
      expect(tools).toEqual([]);
      expect(factory).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      return;
    }
    expect(builder.registry.diagnostics).toEqual([]);
    expect(tools).toHaveLength(1);
    await expect(tools[0]!.execute("admitted", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  },
);
