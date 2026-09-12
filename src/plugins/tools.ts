/** Builds agent tools registered by plugins, preserving plugin scope around callbacks and descriptors. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../agents/glob-pattern.js";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { normalizeConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getLoadedRuntimePluginRegistry,
  createRuntimePluginManifestLookup,
} from "./active-runtime-registry.js";
import {
  isBundledConversationReadToolRegistration,
  isHostRestrictedConversationReadTool,
  registrationIncludesHostRestrictedConversationReadTool,
} from "./compat/conversation-read-tools.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { createInstalledPluginEnabledPredicate } from "./installed-plugin-index.js";
import {
  acquirePluginRegistryForInspection,
  loadPluginRegistryHandle,
  type PluginLoadOptions,
} from "./loader.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestContractSnapshot,
} from "./manifest-contract-eligibility.js";
import { hasManifestToolAvailability } from "./manifest-tool-availability.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginMetadataManifestView } from "./plugin-metadata-snapshot.types.js";
import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import type { PluginRegistry, PluginToolRegistration } from "./registry-types.js";
import { buildPluginRuntimeLoadOptions } from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";
import { findUndeclaredPluginToolNames } from "./tool-contracts.js";
import {
  bindPluginToolCallbacks,
  createPluginToolFactoryResolver,
} from "./tool-factory-runtime.js";
import { createPluginToolAllowlist, type PluginToolAllowlist } from "./tool-grant-allowlist.js";
import { setPluginToolMeta } from "./tool-metadata.js";
import type { OpenClawPluginToolContext } from "./types.js";

function normalizeDenylist(list?: string[]) {
  return compileGlobPatterns({
    raw: list,
    normalize: normalizeToolPolicyName,
  });
}

function denylistBlocksName(name: string, denylist: ReturnType<typeof normalizeDenylist>): boolean {
  const normalized = normalizeToolPolicyName(name);
  return normalized ? matchesAnyGlobPattern(normalized, denylist) : false;
}

function denylistBlocksPlugin(params: {
  pluginId: string;
  denylist: ReturnType<typeof normalizeDenylist>;
}): boolean {
  return (
    denylistBlocksName(params.pluginId, params.denylist) ||
    matchesAnyGlobPattern("group:plugins", params.denylist)
  );
}

function inspectPluginTool(
  tool: unknown,
  name: string,
  clientCaps: ReadonlySet<string>,
  entry: PluginToolRegistration,
  registry: PluginRegistry,
): { tool: AnyAgentTool } | { error: string } | null {
  try {
    if (!isRecord(tool)) {
      return { error: "tool must be an object" };
    }
    const requiredClientCaps = tool.requiredClientCaps;
    const validCaps =
      Array.isArray(requiredClientCaps) &&
      requiredClientCaps.every((requiredCap) => typeof requiredCap === "string");
    if (validCaps && requiredClientCaps.some((requiredCap) => !clientCaps.has(requiredCap))) {
      return null;
    }
    const error = !name
      ? "missing non-empty name"
      : typeof tool.execute !== "function"
        ? `${name} missing execute function`
        : !isRecord(tool.parameters)
          ? `${name} missing parameters object`
          : requiredClientCaps !== undefined && !validCaps
            ? `${name} requiredClientCaps must be an array of strings`
            : undefined;
    return error
      ? { error }
      : { tool: bindPluginToolCallbacks(entry, registry, tool as AnyAgentTool) };
  } catch (error) {
    return { error: formatErrorMessage(error) };
  }
}

function filterManifestToolNamesForAvailability(
  params: Parameters<typeof hasManifestToolAvailability>[0],
): string[] {
  return params.toolNames.filter((toolName) =>
    hasManifestToolAvailability({ ...params, toolNames: [toolName] }),
  );
}

function resolvePluginToolPluginIds(params: {
  config: PluginLoadOptions["config"];
  availabilityConfig?: PluginLoadOptions["config"];
  env: NodeJS.ProcessEnv;
  allowlist: PluginToolAllowlist;
  toolDenylist?: string[];
  hasAuthForProvider?: (providerId: string) => boolean;
  snapshot: PluginMetadataManifestView;
}): string[] {
  const selected: string[] = [];
  const denylist = normalizeDenylist(params.toolDenylist);
  const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
  const snapshot = params.snapshot;
  const isInstalledPluginEnabled = createInstalledPluginEnabledPredicate(
    snapshot.index.plugins,
    params.config,
  );
  for (const plugin of snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
        normalizedConfig: normalizedPlugins,
        isInstalledPluginEnabled,
      })
    ) {
      continue;
    }
    if (denylistBlocksPlugin({ pluginId: plugin.id, denylist })) {
      continue;
    }
    let selectedToolNames = plugin.contracts?.tools ?? [];
    if (!params.allowlist.allowsPlugin(plugin.id)) {
      const matched = selectedToolNames.filter((name) =>
        params.allowlist.allowsTool(plugin.id, name),
      );
      if (params.allowlist.includesDefaults) {
        selectedToolNames = uniqueStrings([
          ...selectedToolNames.filter((name) => plugin.toolMetadata?.[name]?.optional !== true),
          ...matched,
        ]);
      } else {
        selectedToolNames = matched;
      }
    }
    selectedToolNames = selectedToolNames.filter(
      (toolName) => !denylistBlocksName(toolName, denylist),
    );
    const toolNames = filterManifestToolNamesForAvailability({
      plugin,
      toolNames: selectedToolNames,
      config: params.availabilityConfig ?? params.config,
      env: params.env,
      hasAuthForProvider: params.hasAuthForProvider,
    });
    if (toolNames.length > 0) {
      selected.push(plugin.id);
    }
  }
  return [...new Set(selected)].toSorted((a, b) => a.localeCompare(b));
}

type PreparedPluginToolRuntime = {
  loadContext?: ReturnType<typeof resolvePluginRuntimeLoadContext>;
  metadataSnapshot: PluginMetadataManifestView;
  registry?: PluginRegistry;
};

function resolvePluginToolLoadState(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
  preparedRuntime?: PreparedPluginToolRuntime;
}):
  | {
      context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
      env: NodeJS.ProcessEnv;
      loadOptions: PluginLoadOptions;
      onlyPluginIds: string[];
      allowlist: PluginToolAllowlist;
      snapshot: PluginMetadataManifestView;
    }
  | undefined {
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const preparedLoadContext = params.preparedRuntime?.loadContext;
  // The prepared runtime already owns one immutable Gateway plugin generation. Per-turn config
  // and workspace projections cannot invalidate that executable graph or reopen discovery.
  const usePreparedRuntime = preparedLoadContext !== undefined && env === preparedLoadContext.env;
  const context = usePreparedRuntime
    ? preparedLoadContext
    : resolvePluginRuntimeLoadContext({
        config: baseConfig,
        env,
        workspaceDir: params.context.workspaceDir,
      });
  if (context.config.plugins?.enabled === false) {
    return undefined;
  }

  const runtimeOptions = params.allowGatewaySubagentBinding
    ? { allowGatewaySubagentBinding: true as const }
    : undefined;
  const snapshot =
    usePreparedRuntime && params.preparedRuntime
      ? params.preparedRuntime.metadataSnapshot
      : loadManifestContractSnapshot({
          config: context.config,
          workspaceDir: context.workspaceDir,
          env,
        });
  const allowlist = createPluginToolAllowlist(params.toolAllowlist);
  const onlyPluginIds = resolvePluginToolPluginIds({
    config: context.config,
    availabilityConfig: params.context.runtimeConfig ?? context.config,
    env,
    allowlist,
    toolDenylist: params.toolDenylist,
    hasAuthForProvider: params.hasAuthForProvider,
    snapshot,
  });
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    activate: false,
    toolDiscovery: true,
    onlyPluginIds,
    runtimeOptions,
  });
  return {
    context,
    env,
    loadOptions,
    onlyPluginIds,
    allowlist,
    snapshot,
  };
}

export function ensureStandalonePluginToolRegistryLoaded(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): PluginRegistry | undefined {
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState) {
    return undefined;
  }
  return loadPluginRegistryHandle(loadState.loadOptions);
}

type PluginToolResolutionParams = {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  clientCaps?: string[];
  toolAllowlist?: string[];
  toolDenylist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
  runtimeRegistry?: PluginRegistry;
  preparedRuntime?: PreparedPluginToolRuntime;
};

type PluginToolLoadState = NonNullable<ReturnType<typeof resolvePluginToolLoadState>>;

export type PluginToolRegistryAcquisition = {
  registry?: PluginRegistry;
  resolveTools: () => AnyAgentTool[];
  release: () => Promise<void>;
};

/** The serving owner retains this view before invoking factories or applying tool policy. */
export async function acquireStandalonePluginToolRegistry(
  params: Omit<PluginToolResolutionParams, "runtimeRegistry" | "preparedRuntime">,
): Promise<PluginToolRegistryAcquisition> {
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState || loadState.onlyPluginIds.length === 0) {
    return { resolveTools: () => [], release: async () => {} };
  }
  const acquisition = await acquirePluginRegistryForInspection(loadState.loadOptions);
  const hasAuthority = capturePluginLifecycleAuthority(acquisition.registry, undefined, {
    scopedRuntime: true,
  });
  return {
    ...acquisition,
    resolveTools: () => {
      if (!hasAuthority?.()) {
        throw new Error("Plugin tool registry has been released");
      }
      return resolvePluginToolsFromRegistry(
        { ...params, runtimeRegistry: acquisition.registry },
        loadState,
      );
    },
  };
}

export function resolvePluginTools(params: PluginToolResolutionParams): AnyAgentTool[] {
  const loadState = resolvePluginToolLoadState(params);
  return loadState && loadState.onlyPluginIds.length > 0
    ? resolvePluginToolsFromRegistry(params, loadState)
    : [];
}

function resolvePluginToolsFromRegistry(
  params: PluginToolResolutionParams,
  loadState: PluginToolLoadState,
): AnyAgentTool[] {
  const { context, env, onlyPluginIds, allowlist, snapshot } = loadState;
  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolPolicyName(tool)));
  // Tracks which plugin registered each tool name so the plugin-id conflict
  // guard below cannot fire against the plugin's own tools (a plugin may
  // register several tools, one of which shares the plugin id, e.g. canvas).
  const pluginToolOwnersByName = new Map<string, string>();
  const denylist = normalizeDenylist(params.toolDenylist);
  const clientCaps = new Set(params.clientCaps ?? []);
  const runtimeRegistry =
    (context === params.preparedRuntime?.loadContext
      ? params.preparedRuntime.registry
      : params.runtimeRegistry) ??
    getLoadedRuntimePluginRegistry({ workspaceDir: context.workspaceDir });
  // A supplied generation keeps its covered owners even when another plugin must
  // load. Registry caching owns reuse; every assembly calls current-context factories.
  const toolOwners = new Map<
    string,
    { registry: PluginRegistry; tools: PluginToolRegistration[] }
  >();
  const findRuntimeOwner = runtimeRegistry
    ? createRuntimePluginManifestLookup(runtimeRegistry, snapshot.plugins)
    : undefined;
  for (const pluginId of onlyPluginIds) {
    const record = findRuntimeOwner?.(pluginId);
    const instance = record && getPluginInstance(record);
    if (
      runtimeRegistry &&
      instance &&
      (instance.toolRegistrationComplete ||
        runtimeRegistry.tools.some((entry) => entry.pluginId === pluginId))
    ) {
      toolOwners.set(pluginId, { registry: runtimeRegistry, tools: [] });
    }
  }
  const missingPluginIds = onlyPluginIds.filter((pluginId) => !toolOwners.has(pluginId));
  if (missingPluginIds.length > 0) {
    const registry = loadPluginRegistryHandle({
      ...loadState.loadOptions,
      onlyPluginIds: missingPluginIds,
    });
    for (const pluginId of missingPluginIds) {
      toolOwners.set(pluginId, { registry, tools: [] });
    }
  }
  for (const registry of new Set(Array.from(toolOwners.values(), (owner) => owner.registry))) {
    for (const entry of registry.tools) {
      const owner = toolOwners.get(entry.pluginId);
      if (owner?.registry === registry) {
        owner.tools.push(entry);
      }
    }
  }
  const blockedPlugins = new Set<string>();
  const factories = createPluginToolFactoryResolver((message) => context.logger.error(message));

  // Loader manifest order owns duplicate precedence, independent of retained instances.
  const orderedManifests = loadState.loadOptions.manifestRegistry?.plugins ?? snapshot.plugins;
  for (const { id: pluginId } of orderedManifests) {
    const owner = toolOwners.get(pluginId);
    if (!owner) {
      continue;
    }
    toolOwners.delete(pluginId);
    const { registry, tools: registrations } = owner;
    const reportError = (entry: PluginToolRegistration, message: string) => {
      context.logger.error(message);
      registry.diagnostics.push({
        level: "error",
        pluginId: entry.pluginId,
        source: entry.source,
        message,
      });
    };
    if (registrations.length === 0) {
      registry.diagnostics.push({
        level: "warn",
        pluginId,
        source: "plugin-tools",
        message: `plugin tool registry did not include selected plugin tools after cold load (${pluginId})`,
      });
    }
    for (const entry of registrations) {
      if (denylistBlocksPlugin({ pluginId: entry.pluginId, denylist })) {
        continue;
      }
      if (blockedPlugins.has(entry.pluginId)) {
        continue;
      }
      const pluginIdKey = normalizeToolPolicyName(entry.pluginId);
      // A name owned by this same plugin (e.g. the canvas plugin's own `canvas`
      // tool registered by an earlier entry) is not a conflict; only core names
      // and other plugins' tools shadow the plugin id.
      if (
        existingNormalized.has(pluginIdKey) &&
        pluginToolOwnersByName.get(pluginIdKey) !== entry.pluginId
      ) {
        const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
        if (!params.suppressNameConflicts) {
          reportError(entry, message);
        }
        blockedPlugins.add(entry.pluginId);
        continue;
      }
      const manifestPlugin = snapshot.byPluginId.get(entry.pluginId);
      const declaredNames = entry.names ?? [];
      const availabilityNames =
        declaredNames.length > 0 ? declaredNames : (entry.declaredNames ?? []);
      const allowlistNames = manifestPlugin
        ? filterManifestToolNamesForAvailability({
            plugin: manifestPlugin,
            toolNames: availabilityNames,
            config: params.context.runtimeConfig ?? context.config,
            env,
            hasAuthForProvider: params.hasAuthForProvider,
          }).filter((toolName) => !denylistBlocksName(toolName, denylist))
        : declaredNames;
      if (manifestPlugin && availabilityNames.length > 0 && allowlistNames.length === 0) {
        continue;
      }
      const matchesAllowlist =
        (!entry.optional && allowlist.includesDefaults) ||
        (allowlist.size > 0 &&
          (allowlistNames.length === 0 ||
            allowlistNames.some((name) => allowlist.allowsTool(entry.pluginId, name))));
      if (!matchesAllowlist) {
        continue;
      }
      const restrictConversationRead =
        normalizeConversationReadInvocationOrigin(params.context.conversationReadOrigin) !==
          "direct-operator" &&
        !isBundledConversationReadToolRegistration({ entry, manifestPlugin });
      if (
        restrictConversationRead &&
        registrationIncludesHostRestrictedConversationReadTool(entry)
      ) {
        continue;
      }
      const factoryResult = factories.resolve(entry, params.context, declaredNames, owner.registry);
      if (factoryResult.failed) {
        continue;
      }
      const { resolved } = factoryResult;
      if (!resolved) {
        if (declaredNames.length > 0) {
          context.logger.debug?.(
            `plugin tool factory returned null (${entry.pluginId}): [${declaredNames.join(", ")}]`,
          );
        }
        continue;
      }
      const selectedManifestToolNames =
        manifestPlugin && availabilityNames.length > 0
          ? new Set(allowlistNames.map((name) => normalizeToolPolicyName(name)))
          : undefined;
      const manifestContractToolNames =
        manifestPlugin && availabilityNames.length > 0
          ? new Set(availabilityNames.map((name) => normalizeToolPolicyName(name)))
          : undefined;
      for (const toolRaw of Array.isArray(resolved) ? resolved : [resolved]) {
        let rawName: unknown;
        try {
          rawName = isRecord(toolRaw) ? toolRaw.name : undefined;
        } catch (error) {
          reportError(
            entry,
            `plugin tool is malformed (${entry.pluginId}): ${formatErrorMessage(error)}`,
          );
          continue;
        }
        const name = typeof rawName === "string" ? rawName : "";
        const toolName = name.trim();
        const normalizedToolName = normalizeToolPolicyName(name);
        if (
          manifestPlugin &&
          ((manifestPlugin.toolMetadata?.[toolName]?.optional === true &&
            !allowlist.allowsTool(entry.pluginId, toolName)) ||
            (selectedManifestToolNames &&
              manifestContractToolNames?.has(normalizedToolName) &&
              !selectedManifestToolNames.has(normalizedToolName)) ||
            !hasManifestToolAvailability({
              plugin: manifestPlugin,
              toolNames: [toolName],
              config: params.context.runtimeConfig ?? context.config,
              env,
              hasAuthForProvider: params.hasAuthForProvider,
            }))
        ) {
          continue;
        }
        if (
          denylistBlocksName(toolName, denylist) ||
          (entry.optional && !allowlist.allowsTool(entry.pluginId, toolName)) ||
          // Factories may return other declared tools, so check the actual name as well.
          (restrictConversationRead &&
            isHostRestrictedConversationReadTool({ pluginId: entry.pluginId, toolName }))
        ) {
          continue;
        }
        const inspected = inspectPluginTool(toolRaw, toolName, clientCaps, entry, owner.registry);
        if (!inspected) {
          continue;
        }
        if ("error" in inspected) {
          reportError(entry, `plugin tool is malformed (${entry.pluginId}): ${inspected.error}`);
          continue;
        }
        const tool = inspected.tool;
        const undeclared = entry.declaredNames
          ? findUndeclaredPluginToolNames({
              declaredNames: entry.declaredNames,
              toolNames: [name],
            })
          : [];
        if (undeclared.length > 0) {
          const message = `plugin tool is undeclared (${entry.pluginId}): ${undeclared.join(", ")}`;
          reportError(entry, message);
          continue;
        }
        if (existingNormalized.has(normalizedToolName)) {
          const message = `plugin tool name conflict (${entry.pluginId}): ${name}`;
          if (!params.suppressNameConflicts) {
            reportError(entry, message);
          }
          continue;
        }
        existing.add(name);
        existingNormalized.add(normalizedToolName);
        pluginToolOwnersByName.set(normalizedToolName, entry.pluginId);
        const metadata = manifestPlugin?.toolMetadata?.[name];
        setPluginToolMeta(tool, {
          pluginId: entry.pluginId,
          ...(manifestPlugin?.kind ? { kind: manifestPlugin.kind } : {}),
          optional: entry.optional || metadata?.optional === true,
          replaySafe: metadata?.replaySafe === true,
          sideEffecting: metadata?.sideEffecting === true,
          trustedLocalMedia:
            manifestPlugin?.origin === "bundled" &&
            manifestPlugin.contracts?.tools?.includes(name) === true,
        });
        tools.push(tool);
      }
    }
  }

  factories.report();

  return tools;
}
