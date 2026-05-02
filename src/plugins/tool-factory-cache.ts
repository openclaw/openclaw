import type { AnyAgentTool } from "../agents/tools/common.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { PluginLoadOptions } from "./loader.js";
import type { OpenClawPluginToolContext, OpenClawPluginToolFactory } from "./types.js";

const PLUGIN_TOOL_FACTORY_CACHE_LIMIT_PER_FACTORY = 64;

export type PluginToolFactoryResult = AnyAgentTool | AnyAgentTool[] | null | undefined;

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

export function buildPluginToolFactoryCacheKey(params: {
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

export function readCachedPluginToolFactoryResult(params: {
  factory: OpenClawPluginToolFactory;
  cacheKey: string;
}): { hit: boolean; result: PluginToolFactoryResult } {
  const cache = pluginToolFactoryCache.get(params.factory);
  if (!cache || !cache.has(params.cacheKey)) {
    return { hit: false, result: undefined };
  }
  return { hit: true, result: cache.get(params.cacheKey) };
}

export function writeCachedPluginToolFactoryResult(params: {
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
