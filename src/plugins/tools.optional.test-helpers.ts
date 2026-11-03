import assert from "node:assert/strict";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { runPluginRegisterSyncInRegistry } from "./loader-module-runtime.js";
import { createPluginRecord as createLoaderPluginRecord } from "./loader-records.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { makeEmptyPluginMetadataOwners } from "./plugin-metadata-empty.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "./plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";
import { appendRuntimePluginToolGrant } from "./tool-grant-allowlist.js";
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

export function createOptionalToolManifest(
  id: string,
  toolNames: readonly string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    origin: "bundled" as const,
    enabledByDefault: true,
    channels: [],
    providers: [],
    contracts: { tools: [...toolNames] },
    ...overrides,
  };
}

export function createOptionalToolContext(): { config: OpenClawConfig; workspaceDir: string } {
  return {
    config: {
      plugins: {
        enabled: true,
        load: { paths: ["/tmp/plugin.js"] },
        slots: { memory: "none" },
      },
    },
    workspaceDir: "/tmp",
  };
}

export function createConfiguredFeishuToolContext<T extends string>(conversationReadOrigin: T) {
  const context = createOptionalToolContext();
  return {
    ...context,
    config: {
      ...context.config,
      plugins: {
        ...context.config.plugins,
        allow: ["feishu"],
      },
    },
    conversationReadOrigin,
  };
}

export function createXaiToolManifest() {
  const rootPath = "plugins.entries.xai.config";
  return {
    ...createOptionalToolManifest("xai", ["x_search"]),
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
    ...createOptionalToolManifest("feishu", ["feishu_doc"]),
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
  registry.plugins = entries.map(({ pluginId: id, source, origin = "bundled" }) => {
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
  });
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

export function createOptionalToolResolveParams(params?: {
  context?: ReturnType<typeof createOptionalToolContext> & Record<string, unknown>;
  clientCaps?: string[];
  toolAllowlist?: readonly string[];
  toolDenylist?: readonly string[];
  existingToolNames?: Set<string>;
  env?: NodeJS.ProcessEnv;
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  runtimePluginToolGrant?: { pluginId: string; toolNames: readonly string[] };
}) {
  const toolAllowlist = appendRuntimePluginToolGrant(
    [...(params?.toolAllowlist ?? [])],
    params?.runtimePluginToolGrant,
  );
  return {
    context: (params?.context ?? createOptionalToolContext()) as never,
    ...(params?.clientCaps ? { clientCaps: params.clientCaps } : {}),
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(params?.toolDenylist ? { toolDenylist: [...params.toolDenylist] } : {}),
    ...(params?.existingToolNames ? { existingToolNames: params.existingToolNames } : {}),
    ...(params?.env ? { env: params.env } : {}),
    ...(params?.suppressNameConflicts ? { suppressNameConflicts: true } : {}),
    ...(params?.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
  };
}

export function installOptionalToolManifestSnapshots(
  params: {
    config: ReturnType<typeof createOptionalToolContext>["config"];
    compatibleConfigs?: ReturnType<typeof createOptionalToolContext>["config"][];
    env?: NodeJS.ProcessEnv;
    plugins: Record<string, unknown>[];
  },
  setSnapshot: typeof import("./current-plugin-metadata.test-support.js").setCurrentPluginMetadataSnapshot,
) {
  const plugins = params.plugins.map((plugin): Record<string, unknown> => ({
    rootDir: "/tmp",
    source: `/tmp/${String(plugin.id)}.js`,
    ...plugin,
  }));
  const snapshot = {
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    workspaceDir: "/tmp",
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: "test",
      generatedAtMs: 0,
      installRecords: {},
      plugins: plugins.map((plugin) => ({
        pluginId: String(plugin.id),
        origin: plugin.origin,
        enabled: true,
        enabledByDefault: plugin.enabledByDefault,
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      })),
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [String(plugin.id), plugin])),
    normalizePluginId: (id: string) => id,
    owners: makeEmptyPluginMetadataOwners(),
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: plugins.length,
      manifestPluginCount: plugins.length,
    },
  };
  setSnapshot(snapshot as never, {
    config: params.config,
    compatibleConfigs: params.compatibleConfigs,
    env: params.env ?? process.env,
    workspaceDir: "/tmp",
  });
  return snapshot;
}
