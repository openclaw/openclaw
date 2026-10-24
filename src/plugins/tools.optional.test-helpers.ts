import assert from "node:assert/strict";
import path from "node:path";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord as createLoaderPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";
import type { OpenClawPluginToolContext } from "./tool-types.js";

export type MockRegistryToolEntry = {
  pluginId: string;
  optional: boolean;
  origin?: "bundled" | "global" | "workspace" | "config";
  source: string;
  names: string[];
  declaredNames?: string[];
  factory: (ctx: OpenClawPluginToolContext) => unknown;
};

const toolManifest = (id: string, tool: string) => ({
  id,
  origin: "bundled",
  enabledByDefault: true,
  channels: [],
  providers: [],
  contracts: { tools: [tool] },
});

export function createXaiToolManifest() {
  const rootPath = "plugins.entries.xai.config";
  return {
    ...toolManifest("xai", "x_search"),
    providers: ["xai"],
    setup: { providers: [{ id: "xai", envVars: ["XAI_API_KEY"] }] },
    toolMetadata: {
      x_search: {
        replaySafe: true,
        authSignals: [{ provider: "xai" }],
        configSignals: [{ rootPath, overlayPath: "webSearch", required: ["apiKey"] }],
      },
    },
  };
}

export function createFeishuToolManifest() {
  const credentials = { rootPath: "channels.feishu", required: ["appId", "appSecret"] };
  return {
    ...toolManifest("feishu", "feishu_doc"),
    channels: ["feishu"],
    toolMetadata: {
      feishu_doc: {
        configSignals: [credentials, { ...credentials, overlayMapPath: "accounts" }],
      },
    },
  };
}

export const makeTool = (name: string) => ({
  name,
  description: `${name} tool`,
  parameters: { type: "object", properties: {} },
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
});

export function createNamedToolEntry(
  pluginId: string,
  names: string | readonly string[],
  overrides: Partial<MockRegistryToolEntry> = {},
): MockRegistryToolEntry {
  const toolNames = typeof names === "string" ? [names] : [...names];
  return {
    pluginId,
    optional: false,
    source: `/tmp/${pluginId}.js`,
    names: toolNames,
    factory: () => (toolNames.length === 1 ? makeTool(toolNames[0]!) : toolNames.map(makeTool)),
    ...overrides,
  };
}

export function createToolRegistry(
  entries: MockRegistryToolEntry[],
  registrationMode: "full" | "discovery" | "tool-discovery" = "full",
) {
  const builder = createTestPluginRegistry(createPluginRuntime());
  const registry: Omit<typeof builder.registry, "tools"> & {
    tools: Array<
      Omit<MockRegistryToolEntry, "declaredNames"> & { declaredNames?: ReadonlySet<string> }
    >;
  } = builder.registry;
  registry.plugins = entries.map((entry) =>
    createToolRuntimeRecord(entry.pluginId, entry.source, entry.origin),
  );
  registry.tools = entries.map((entry, index) => {
    const record = registry.plugins[index]!;
    const api = builder.createApi(record, { config: {}, registrationMode });
    runPluginRegisterSyncInRegistry(() => {}, api, builder.registry, entry.pluginId);
    const instance = getPluginInstance(record);
    assert(instance, "expected the registry API's plugin instance");
    instance.admitFactory(entry.factory, "tool");
    const { declaredNames, ...registration } = entry;
    return {
      ...registration,
      factory: instance.wrap(entry.factory),
      ...(declaredNames === undefined ? {} : { declaredNames: new Set(declaredNames) }),
    };
  });
  return registry;
}

function createToolRuntimeRecord(
  id: string,
  source = `/tmp/${id}.js`,
  origin: MockRegistryToolEntry["origin"] = "bundled",
) {
  const rootDir = path.dirname(source);
  const artifact = { source, rootDir, origin, preferBuiltPluginArtifacts: false };
  const record = createLoaderPluginRecord({ id, ...artifact, enabled: true, configSchema: true });
  bindPluginRuntimeArtifactSelection(record, {
    preferBuiltPluginArtifacts: false,
    runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
  });
  return record;
}
