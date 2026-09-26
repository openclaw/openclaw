import path from "node:path";
import { buildPluginApi } from "./api-builder.js";
import { instrumentPluginInstanceApi } from "./api-facades.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord as createLoaderPluginRecord } from "./loader-records.js";
import { PluginInstance } from "./plugin-instance.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-selection.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRuntime } from "./runtime/index.js";

export type MockRegistryToolEntry = {
  pluginId: string;
  optional: boolean;
  origin?: "bundled" | "global" | "workspace" | "config";
  source: string;
  names: string[];
  declaredNames?: string[];
  factory: (ctx: unknown) => unknown;
};

export function makeTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

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
    factory: () =>
      toolNames.length === 1 ? makeTool(toolNames[0]!) : toolNames.map((name) => makeTool(name)),
    ...overrides,
  };
}

export function createToolRegistry(
  entries: MockRegistryToolEntry[],
  registrationMode: "full" | "discovery" | "tool-discovery" = "full",
) {
  const tools: Array<
    Omit<MockRegistryToolEntry, "declaredNames"> & { declaredNames?: ReadonlySet<string> }
  > = [];
  const registry = {
    ...createEmptyPluginRegistry(),
    plugins: entries.map((entry) =>
      createToolRuntimeRecord(entry.pluginId, entry.source, entry.origin),
    ),
    tools,
  };
  registry.tools = entries.map((entry, index) => {
    const instance = new PluginInstance(entry.pluginId, {
      record: registry.plugins[index]!,
      registry: registry as never,
    });
    const api = instrumentPluginInstanceApi(
      buildPluginApi({
        id: entry.pluginId,
        name: entry.pluginId,
        source: entry.source,
        registrationMode,
        config: {},
        runtime: createPluginRuntime(),
        logger: { info() {}, warn() {}, error() {} },
        resolvePath: (value) => value,
      }),
      instance,
    );
    runPluginRegisterSyncInRegistry(() => {}, api, registry as never, entry.pluginId);
    const { declaredNames, ...registration } = entry;
    return {
      ...registration,
      factory: instance.wrap(entry.factory),
      ...(declaredNames === undefined ? {} : { declaredNames: new Set(declaredNames) }),
    };
  });
  return registry;
}

export function createToolRuntimeRecord(
  id: string,
  source = `/tmp/${id}.js`,
  origin: MockRegistryToolEntry["origin"] = "bundled",
) {
  const artifact = {
    source,
    rootDir: path.dirname(source),
    origin,
    preferBuiltPluginArtifacts: false,
  };
  const record = createLoaderPluginRecord({ id, ...artifact, enabled: true, configSchema: true });
  bindPluginRuntimeArtifactSelection(record, {
    preferBuiltPluginArtifacts: false,
    runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
  });
  return record;
}
