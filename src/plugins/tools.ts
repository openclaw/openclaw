import { normalizeToolName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import { applyTestPluginDefaults, normalizePluginsConfig } from "./config-state.js";
import { resolveRuntimePluginRegistry, type PluginLoadOptions } from "./loader.js";
import {
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRuntimeSubagentMode,
} from "./runtime.js";
import {
  buildPluginRuntimeLoadOptions,
  resolvePluginRuntimeLoadContext,
} from "./runtime/load-context.js";
import type { OpenClawPluginToolContext, OpenClawPluginToolFactory } from "./types.js";

export type PluginToolMeta = {
  pluginId: string;
  optional: boolean;
};

const pluginToolMeta = new WeakMap<AnyAgentTool, PluginToolMeta>();
const PLUGIN_TOOL_FACTORY_CACHE_LIMIT_PER_FACTORY = 64;

type PluginToolFactoryResult = AnyAgentTool | AnyAgentTool[] | null | undefined;

let pluginToolFactoryCache = new WeakMap<
  OpenClawPluginToolFactory,
  Map<string, PluginToolFactoryResult>
>();
let pluginToolFactoryCacheObjectIds = new WeakMap<object, number>();
let nextPluginToolFactoryCacheObjectId = 1;

export function resetPluginToolFactoryCache(): void {
  pluginToolFactoryCache = new WeakMap();
  pluginToolFactoryCacheObjectIds = new WeakMap();
  nextPluginToolFactoryCacheObjectId = 1;
}

function getPluginToolFactoryCacheObjectId(value: object | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const existing = pluginToolFactoryCacheObjectIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const next = nextPluginToolFactoryCacheObjectId++;
  pluginToolFactoryCacheObjectIds.set(value, next);
  return next;
}

function getPluginToolFactoryConfigCacheKey(
  value: PluginLoadOptions["config"] | null | undefined,
): string | number | null {
  if (!value) {
    return null;
  }
  try {
    return resolveRuntimeConfigCacheKey(value);
  } catch {
    return getPluginToolFactoryCacheObjectId(value);
  }
}

function buildPluginToolFactoryCacheKey(params: {
  ctx: OpenClawPluginToolContext;
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
}): string {
  const { ctx } = params;
  return JSON.stringify({
    config: getPluginToolFactoryConfigCacheKey(ctx.config),
    runtimeConfig: getPluginToolFactoryConfigCacheKey(ctx.runtimeConfig),
    currentRuntimeConfig: getPluginToolFactoryConfigCacheKey(params.currentRuntimeConfig),
    fsPolicy: ctx.fsPolicy ?? null,
    workspaceDir: ctx.workspaceDir ?? null,
    agentDir: ctx.agentDir ?? null,
    agentId: ctx.agentId ?? null,
    sessionKey: ctx.sessionKey ?? null,
    sessionId: ctx.sessionId ?? null,
    browser: ctx.browser ?? null,
    messageChannel: ctx.messageChannel ?? null,
    agentAccountId: ctx.agentAccountId ?? null,
    deliveryContext: ctx.deliveryContext ?? null,
    requesterSenderId: ctx.requesterSenderId ?? null,
    senderIsOwner: ctx.senderIsOwner ?? null,
    sandboxed: ctx.sandboxed ?? null,
  });
}

function readCachedPluginToolFactoryResult(params: {
  factory: OpenClawPluginToolFactory;
  cacheKey: string;
}): { hit: boolean; result: PluginToolFactoryResult } {
  const cache = pluginToolFactoryCache.get(params.factory);
  if (!cache || !cache.has(params.cacheKey)) {
    return { hit: false, result: undefined };
  }
  return { hit: true, result: cache.get(params.cacheKey) };
}

function writeCachedPluginToolFactoryResult(params: {
  factory: OpenClawPluginToolFactory;
  cacheKey: string;
  result: PluginToolFactoryResult;
}): void {
  let cache = pluginToolFactoryCache.get(params.factory);
  if (!cache) {
    cache = new Map();
    pluginToolFactoryCache.set(params.factory, cache);
  }
  if (!cache.has(params.cacheKey) && cache.size >= PLUGIN_TOOL_FACTORY_CACHE_LIMIT_PER_FACTORY) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(params.cacheKey, params.result);
}

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

function resolvePluginToolRegistry(params: {
  loadOptions: PluginLoadOptions;
  allowGatewaySubagentBinding?: boolean;
}) {
  if (
    params.allowGatewaySubagentBinding &&
    getActivePluginRegistryKey() &&
    getActivePluginRuntimeSubagentMode() === "gateway-bindable"
  ) {
    return getActivePluginRegistry() ?? resolveRuntimePluginRegistry(params.loadOptions);
  }
  return resolveRuntimePluginRegistry(params.loadOptions);
}

export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
  suppressNameConflicts?: boolean;
  allowGatewaySubagentBinding?: boolean;
  env?: NodeJS.ProcessEnv;
}): AnyAgentTool[] {
  // Fast path: when plugins are effectively disabled, avoid discovery/jiti entirely.
  // This matters a lot for unit tests and for tool construction hot paths.
  const env = params.env ?? process.env;
  const baseConfig = applyTestPluginDefaults(params.context.config ?? {}, env);
  const context = resolvePluginRuntimeLoadContext({
    config: baseConfig,
    env,
    workspaceDir: params.context.workspaceDir,
  });
  const normalized = normalizePluginsConfig(context.config.plugins);
  if (!normalized.enabled) {
    return [];
  }

  const runtimeOptions = params.allowGatewaySubagentBinding
    ? { allowGatewaySubagentBinding: true as const }
    : undefined;
  const loadOptions = buildPluginRuntimeLoadOptions(context, {
    installBundledRuntimeDeps: false,
    activate: false,
    toolDiscovery: true,
    runtimeOptions,
  });
  const registry = resolvePluginToolRegistry({
    loadOptions,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  if (!registry) {
    return [];
  }

  const tools: AnyAgentTool[] = [];
  const existing = params.existingToolNames ?? new Set<string>();
  const existingNormalized = new Set(Array.from(existing, (tool) => normalizeToolName(tool)));
  const allowlist = normalizeAllowlist(params.toolAllowlist);
  const blockedPlugins = new Set<string>();
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
    let resolved: PluginToolFactoryResult = null;
    const factoryCacheKey = buildPluginToolFactoryCacheKey({
      ctx: params.context,
      currentRuntimeConfig: currentRuntimeConfigForFactoryCache,
    });
    const cached = readCachedPluginToolFactoryResult({
      factory: entry.factory,
      cacheKey: factoryCacheKey,
    });
    if (cached.hit) {
      resolved = cached.result;
    } else {
      try {
        resolved = entry.factory(params.context);
      } catch (err) {
        context.logger.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
        continue;
      }
      writeCachedPluginToolFactoryResult({
        factory: entry.factory,
        cacheKey: factoryCacheKey,
        result: resolved,
      });
    }
    if (!resolved) {
      if ((entry.names?.length ?? 0) > 0) {
        context.logger.debug?.(
          `plugin tool factory returned null (${entry.pluginId}): [${entry.names.join(", ")}]`,
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

  return tools;
}
