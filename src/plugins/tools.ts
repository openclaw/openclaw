import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getLoadedRuntimePluginRegistry } from "./active-runtime-registry.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import type { PluginLoadOptions } from "./loader.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestContractSnapshot,
} from "./manifest-contract-eligibility.js";
import { hasManifestToolAvailability } from "./manifest-tool-availability.js";
import type { PluginToolRegistration } from "./registry-types.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import { ensureStandaloneRuntimePluginRegistryLoaded } from "./runtime/standalone-runtime-registry-loader.js";
import { findUndeclaredPluginToolNames } from "./tool-contracts.js";
import {
  buildPluginToolFactoryCacheKey,
  readCachedPluginToolFactoryResult,
  type PluginToolFactoryResult,
  writeCachedPluginToolFactoryResult,
} from "./tool-factory-cache.js";
import type { OpenClawPluginToolContext } from "./types.js";

export { resetPluginToolFactoryCache } from "./tool-factory-cache.js";

export type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

type PluginToolFactoryTimingResult = "array" | "error" | "null" | "single";

type PluginToolFactoryTiming = {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  result: PluginToolFactoryTimingResult;
  resultCount: number;
  optional: boolean;
};

const log = createSubsystemLogger("plugins/tools");
const PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS = 5_000;
const PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS = 1_000;
const PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT = 20;

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();

export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}

export function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined {
  return pluginToolMeta.get(tool);
}

export function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void {
  const meta = pluginToolMeta.get(source);
  if (meta) {
    pluginToolMeta.set(target, meta);
  }
}

/**
 * Builds a collision-proof key for plugin-owned tool metadata lookups.
 */
export function buildPluginToolMetadataKey(pluginId: string, toolName: string): string {
  return JSON.stringify([pluginId, toolName]);
}

function normalizeAllowlist(list?: string[]) {
  return new Set((list ?? []).map(normalizeToolName).filter(Boolean));
}

function isOptionalToolAllowed(params: {
  toolName: string;
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const toolName = normalizeToolName(params.toolName);
  if (params.allowlist.has(toolName)) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.allowlist.has("group:plugins");
}

function isOptionalToolEntryPotentiallyAllowed(params: {
  names: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return false;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey) || params.allowlist.has("group:plugins")) {
    return true;
  }
  if (params.names.length === 0) {
    return true;
  }
  return params.names.some((name) => params.allowlist.has(normalizeToolName(name)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readPluginToolName(tool: unknown): string {
  if (!isRecord(tool)) {
    return "";
  }
  // Optional-tool allowlists need a best-effort name before full shape validation.
  return typeof tool.name === "string" ? tool.name.trim() : "";
}

function toElapsedMs(value: number): number {
  return Math.max(0, Math.round(value));
}

function describePluginToolFactoryResult(
  resolved: AnyAgentTool | AnyAgentTool[] | null | undefined,
  failed: boolean,
): { result: PluginToolFactoryTimingResult; resultCount: number } {
  if (failed) {
    return { result: "error", resultCount: 0 };
  }
  if (!resolved) {
    return { result: "null", resultCount: 0 };
  }
  if (Array.isArray(resolved)) {
    return { result: "array", resultCount: resolved.length };
  }
  return { result: "single", resultCount: 1 };
}

function createPluginToolFactoryTiming(params: {
  pluginId: string;
  names: string[];
  durationMs: number;
  elapsedMs: number;
  resolved: PluginToolFactoryResult;
  failed: boolean;
  optional: boolean;
}): PluginToolFactoryTiming {
  const result = describePluginToolFactoryResult(params.resolved, params.failed);
  return {
    pluginId: params.pluginId,
    names: params.names,
    durationMs: params.durationMs,
    elapsedMs: params.elapsedMs,
    result: result.result,
    resultCount: result.resultCount,
    optional: params.optional,
  };
}

function resolvePluginToolFactoryEntry(params: {
  entry: PluginToolRegistration;
  ctx: OpenClawPluginToolContext;
  declaredNames: string[];
  currentRuntimeConfig: PluginLoadOptions["config"] | null | undefined;
  factoryTimingStartedAt: number;
  logError: (message: string) => void;
}): {
  resolved: PluginToolFactoryResult;
  failed: boolean;
  timing: PluginToolFactoryTiming;
} {
  let resolved: PluginToolFactoryResult = null;
  let failed = false;
  const factoryStartedAt = Date.now();
  const factoryCacheKey = buildPluginToolFactoryCacheKey({
    ctx: params.ctx,
    currentRuntimeConfig: params.currentRuntimeConfig,
  });
  const cached = readCachedPluginToolFactoryResult({
    factory: params.entry.factory,
    cacheKey: factoryCacheKey,
  });

  if (cached.hit) {
    resolved = cached.result;
    return {
      resolved,
      failed: false,
      timing: createPluginToolFactoryTiming({
        pluginId: params.entry.pluginId,
        names: params.declaredNames,
        durationMs: 0,
        elapsedMs: toElapsedMs(Date.now() - params.factoryTimingStartedAt),
        resolved,
        failed: false,
        optional: params.entry.optional,
      }),
    };
  }

  try {
    resolved = params.entry.factory(params.ctx);
  } catch (err) {
    failed = true;
    params.logError(`plugin tool failed (${params.entry.pluginId}): ${String(err)}`);
  } finally {
    if (!failed) {
      writeCachedPluginToolFactoryResult({
        factory: params.entry.factory,
        cacheKey: factoryCacheKey,
        result: resolved,
      });
    }
  }

  const factoryEndedAt = Date.now();
  return {
    resolved,
    failed,
    timing: createPluginToolFactoryTiming({
      pluginId: params.entry.pluginId,
      names: params.declaredNames,
      durationMs: toElapsedMs(factoryEndedAt - factoryStartedAt),
      elapsedMs: toElapsedMs(factoryEndedAt - params.factoryTimingStartedAt),
      resolved,
      failed,
      optional: params.entry.optional,
    }),
  };
}

function formatPluginToolFactoryTiming(timing: PluginToolFactoryTiming): string {
  const names = timing.names.length > 0 ? timing.names.join("|") : "-";
  return [
    `${timing.pluginId}:${timing.durationMs}ms@${timing.elapsedMs}ms`,
    `names=[${names}]`,
    `result=${timing.result}`,
    `count=${timing.resultCount}`,
    `optional=${String(timing.optional)}`,
  ].join(" ");
}

function formatPluginToolFactoryTimingSummary(params: {
  totalMs: number;
  timings: PluginToolFactoryTiming[];
}): string {
  const ranked = params.timings
    .toSorted(
      (left, right) =>
        right.durationMs - left.durationMs || left.pluginId.localeCompare(right.pluginId),
    )
    .slice(0, PLUGIN_TOOL_FACTORY_SUMMARY_LIMIT);
  const omitted = Math.max(0, params.timings.length - ranked.length);
  const factories =
    ranked.length > 0
      ? ranked.map((timing) => formatPluginToolFactoryTiming(timing)).join(", ")
      : "none";
  return [
    "[trace:plugin-tools] factory timings",
    `totalMs=${params.totalMs}`,
    `factoryCount=${params.timings.length}`,
    `shown=${ranked.length}`,
    `omitted=${omitted}`,
    `factories=${factories}`,
  ].join(" ");
}

function shouldWarnPluginToolFactoryTimings(params: {
  totalMs: number;
  timings: PluginToolFactoryTiming[];
}): boolean {
  return (
    params.totalMs >= PLUGIN_TOOL_FACTORY_WARN_TOTAL_MS ||
    params.timings.some((timing) => timing.durationMs >= PLUGIN_TOOL_FACTORY_WARN_FACTORY_MS)
  );
}

function describeMalformedPluginTool(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return "tool must be an object";
  }
  const name = readPluginToolName(tool);
  if (!name) {
    return "missing non-empty name";
  }
  if (typeof tool.execute !== "function") {
    return `${name} missing execute function`;
  }
  if (!isRecord(tool.parameters)) {
    return `${name} missing parameters object`;
  }
  return undefined;
}

function pluginToolNamesMatchAllowlist(params: {
  names: readonly string[];
  pluginId: string;
  optional: boolean;
  allowlist: Set<string>;
}): boolean {
  if (params.allowlist.size === 0) {
    return !params.optional;
  }
  return isOptionalToolEntryPotentiallyAllowed(params);
}

function manifestToolContractMatchesAllowlist(params: {
  toolNames: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): boolean {
  if (params.toolNames.length === 0) {
    return false;
  }
  if (params.allowlist.size === 0) {
    return true;
  }
  if (params.allowlist.has("*") || params.allowlist.has("group:plugins")) {
    return true;
  }
  const pluginKey = normalizeToolName(params.pluginId);
  if (params.allowlist.has(pluginKey)) {
    return true;
  }
  return params.toolNames.some((name) => params.allowlist.has(normalizeToolName(name)));
}

function listManifestToolNamesForAvailability(params: {
  toolNames: readonly string[];
  pluginId: string;
  allowlist: Set<string>;
}): string[] {
  if (
    params.allowlist.size === 0 ||
    params.allowlist.has("*") ||
    params.allowlist.has("group:plugins")
  ) {
    return [...params.toolNames];
  }
  if (params.allowlist.has(normalizeToolName(params.pluginId))) {
    return [...params.toolNames];
  }
  return params.toolNames.filter((name) => params.allowlist.has(normalizeToolName(name)));
}

function resolvePluginToolRuntimePluginIds(params: {
  config: PluginLoadOptions["config"];
  availabilityConfig?: PluginLoadOptions["config"];
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  toolAllowlist?: string[];
  hasAuthForProvider?: (providerId: string) => boolean;
}): string[] {
  const pluginIds = new Set<string>();
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const snapshot = loadManifestContractSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  for (const plugin of snapshot.plugins) {
    if (
      !isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
      })
    ) {
      continue;
    }
    const toolNames = plugin.contracts?.tools ?? [];
    if (
      manifestToolContractMatchesAllowlist({
        toolNames,
        pluginId: plugin.id,
        allowlist,
      }) &&
      hasManifestToolAvailability({
        plugin,
        toolNames: listManifestToolNamesForAvailability({
          toolNames,
          pluginId: plugin.id,
          allowlist,
        }),
        config: params.availabilityConfig ?? params.config,
        env: params.env,
        hasAuthForProvider: params.hasAuthForProvider,
      })
    ) {
      pluginIds.add(plugin.id);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

function resolvePluginToolRegistry(params: {
  loadOptions: PluginLoadOptions;
  onlyPluginIds?: readonly string[];
}) {
  return getLoadedRuntimePluginRegistry({
    env: params.loadOptions.env,
    loadOptions: params.loadOptions,
    workspaceDir: params.loadOptions.workspaceDir,
    requiredPluginIds: params.onlyPluginIds,
    surface: "channel",
  });
}

function resolvePluginToolLoadState(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}):
  | {
      context: ReturnType<typeof resolvePluginRuntimeLoadContext>;
      loadOptions: PluginLoadOptions;
      onlyPluginIds: string[];
    }
  | undefined {
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const context = resolvePluginRuntimeLoadContext({
    config: baseConfig,
    env,
    workspaceDir: params.context.workspaceDir,
  });
  const normalized = normalizePluginsConfig(context.config.plugins);
  if (!normalized.enabled) {
    return undefined;
  }

  const runtimeOptions = params.allowGatewaySubagentBinding
    ? { allowGatewaySubagentBinding: true as const }
    : undefined;
  const onlyPluginIds = resolvePluginToolRuntimePluginIds({
    config: context.config,
    availabilityConfig: params.context.runtimeConfig ?? context.config,
    workspaceDir: context.workspaceDir,
    env,
    toolAllowlist: params.toolAllowlist,
    hasAuthForProvider: params.hasAuthForProvider,
  });
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    activate: false,
    toolDiscovery: true,
    ...(onlyPluginIds !== undefined ? { onlyPluginIds } : {}),
    runtimeOptions,
  });
  return { context, loadOptions, onlyPluginIds };
}

export function ensureStandalonePluginToolRegistryLoaded(params: {
  context: OpenClawPluginToolContext;
  toolAllowlist?: string[];
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): void {
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState) {
    return;
  }
  ensureStandaloneRuntimePluginRegistryLoaded({
    surface: "channel",
    requiredPluginIds: loadState.onlyPluginIds,
    loadOptions: loadState.loadOptions,
  });
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  hasAuthForProvider?: (providerId: string) => boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const loadState = resolvePluginToolLoadState(params);
  if (!loadState) {
    return [];
  }
  const { context, loadOptions, onlyPluginIds } = loadState;
  const registry = resolvePluginToolRegistry({
    loadOptions,
    onlyPluginIds,
  });
  if (!registry) {
    return [];
  }

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const scopedPluginIds = new Set(onlyPluginIds);
  const blockedPlugins = new Set<string>();
  const factoryTimingStartedAt = Date.now();
  const factoryTimings: PluginToolFactoryTiming[] = [];
  let currentRuntimeConfigForFactoryCache: PluginLoadOptions["config"] | null | undefined =
    params.context.runtimeConfig;
  if (currentRuntimeConfigForFactoryCache === undefined && params.context.getRuntimeConfig) {
    try {
      currentRuntimeConfigForFactoryCache = params.context.getRuntimeConfig();
    } catch {
      currentRuntimeConfigForFactoryCache = null;
    }
  }

  for (const entry of registry.tools) {
    if (!scopedPluginIds.has(entry.pluginId)) {
      continue;
    }
    if (blockedPlugins.has(entry.pluginId)) {
      continue;
    }
    const pluginIdKey = normalizeToolName(entry.pluginId);
    if (existingNormalized.has(pluginIdKey)) {
      const message = `plugin id conflicts with core tool name (${entry.pluginId})`;
      if (!params.suppressNameConflicts) {
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
      }
      blockedPlugins.add(entry.pluginId);
      continue;
    }
    const declaredNames = entry.names ?? [];
    if (
      !pluginToolNamesMatchAllowlist({
        names: declaredNames,
        pluginId: entry.pluginId,
        optional: entry.optional,
        allowlist,
      })
    ) {
      continue;
    }
    const factoryResult = resolvePluginToolFactoryEntry({
      entry,
      ctx: params.context,
      declaredNames,
      currentRuntimeConfig: currentRuntimeConfigForFactoryCache,
      factoryTimingStartedAt,
      logError: (message) => context.logger.error(message),
    });
    factoryTimings.push(factoryResult.timing);
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
    const listRaw: unknown[] = Array.isArray(resolved) ? resolved : [resolved];
    const list = entry.optional
      ? listRaw.filter((tool) =>
          isOptionalToolAllowed({
            toolName: readPluginToolName(tool),
            pluginId: entry.pluginId,
            allowlist,
          }),
        )
      : listRaw;
    if (list.length === 0) {
      continue;
    }
    const nameSet = new Set<string>();
    for (const toolRaw of list) {
      // Plugin factories run at request time and can return arbitrary values; isolate
      // malformed tools here so one bad plugin tool cannot poison every provider.
      const malformedReason = describeMalformedPluginTool(toolRaw);
      if (malformedReason) {
        const message = `plugin tool is malformed (${entry.pluginId}): ${malformedReason}`;
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
        continue;
      }
      const tool = toolRaw as AnyAgentTool;
      const undeclared = entry.declaredNames
        ? findUndeclaredPluginToolNames({
            declaredNames: entry.declaredNames,
            toolNames: [tool.name],
          })
        : [];
      if (undeclared.length > 0) {
        const message = `plugin tool is undeclared (${entry.pluginId}): ${undeclared.join(", ")}`;
        context.logger.error(message);
        registry.diagnostics.push({
          level: "error",
          pluginId: entry.pluginId,
          source: entry.source,
          message,
        });
        continue;
      }
      if (nameSet.has(tool.name) || existing.has(tool.name)) {
        const message = `plugin tool name conflict (${entry.pluginId}): ${tool.name}`;
        if (!params.suppressNameConflicts) {
          context.logger.error(message);
          registry.diagnostics.push({
            level: "error",
            pluginId: entry.pluginId,
            source: entry.source,
            message,
          });
        }
        continue;
      }
      nameSet.add(tool.name);
      existing.add(tool.name);
      pluginToolMeta.set(tool, {
        pluginId: entry.pluginId,
        optional: entry.optional,
      });
      tools.push(tool);
    }
  }

  if (factoryTimings.length > 0) {
    const totalMs =
      factoryTimings.at(-1)?.elapsedMs ?? toElapsedMs(Date.now() - factoryTimingStartedAt);
    const timingSummary = { totalMs, timings: factoryTimings };
    if (shouldWarnPluginToolFactoryTimings(timingSummary)) {
      log.warn(formatPluginToolFactoryTimingSummary(timingSummary));
    } else if (log.isEnabled("trace")) {
      log.trace(formatPluginToolFactoryTimingSummary(timingSummary));
    }
  }

  return tools;
}
