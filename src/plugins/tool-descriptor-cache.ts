import fs from "node:fs";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { JsonObject, ToolDescriptor } from "../tools/types.js";
import type { PluginLoadOptions } from "./loader.js";
import type { OpenClawPluginToolContext } from "./types.js";

const PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION = 1;
const PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT = 256;

export type CachedPluginToolDescriptor = {
  descriptor: ToolDescriptor;
  displaySummary?: string;
  optional: boolean;
};

const descriptorCache = new Map<string, CachedPluginToolDescriptor[]>();
let descriptorCacheObjectIds = new WeakMap<object, number>();
let nextDescriptorCacheObjectId = 1;

export type PluginToolDescriptorConfigCacheKeyMemo = WeakMap<object, string | number | null>;

/** Creates a per-resolution memo so equivalent config objects share descriptor cache keys. */
export function createPluginToolDescriptorConfigCacheKeyMemo(): PluginToolDescriptorConfigCacheKeyMemo {
  return new WeakMap();
}

/** Clears process-local plugin tool descriptor cache state for tests and plugin lifecycle resets. */
export function resetPluginToolDescriptorCache(): void {
  descriptorCache.clear();
  descriptorCacheObjectIds = new WeakMap();
  nextDescriptorCacheObjectId = 1;
}

function sourceFingerprint(source: string): string {
  try {
    const stat = fs.statSync(source);
    return `${stat.size}:${Math.round(stat.mtimeMs)}`;
  } catch {
    return "missing";
  }
}

function getDescriptorCacheObjectId(value: object | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const existing = descriptorCacheObjectIds.get(value);
  if (existing !== undefined) {
    return existing;
  }
  const next = nextDescriptorCacheObjectId++;
  descriptorCacheObjectIds.set(value, next);
  return next;
}

function stripDescriptorVolatileConfigFields(
  value: NonNullable<PluginLoadOptions["config"]>,
): NonNullable<PluginLoadOptions["config"]> {
  if (typeof value !== "object") {
    return value;
  }
  if (!("meta" in value) && !("wizard" in value)) {
    return value;
  }
  // Wizard/meta fields are UI discovery state, not runtime tool inputs. Dropping
  // them prevents setup progress churn from invalidating stable descriptors.
  const { meta: _meta, wizard: _wizard, ...stableConfig } = value as Record<string, unknown>;
  return stableConfig as NonNullable<PluginLoadOptions["config"]>;
}

function getDescriptorConfigCacheKey(
  value: PluginLoadOptions["config"] | null | undefined,
  memo?: PluginToolDescriptorConfigCacheKeyMemo,
): string | number | null {
  if (!value) {
    return null;
  }
  const cached = memo?.get(value);
  if (cached !== undefined) {
    return cached;
  }
  let resolved: string | number | null;
  try {
    resolved = resolveRuntimeConfigCacheKey(stripDescriptorVolatileConfigFields(value));
  } catch {
    resolved = getDescriptorCacheObjectId(value);
  }
  memo?.set(value, resolved);
  return resolved;
}

function buildDescriptorContextCacheKey(params: {
  ctx: OpenClawPluginToolContext;
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo?: PluginToolDescriptorConfigCacheKeyMemo;
}): string {
  const { ctx } = params;
  return JSON.stringify({
    config: getDescriptorConfigCacheKey(ctx.config, params.configCacheKeyMemo),
    runtimeConfig: getDescriptorConfigCacheKey(ctx.runtimeConfig, params.configCacheKeyMemo),
    currentRuntimeConfig: getDescriptorConfigCacheKey(
      params.currentRuntimeConfig,
      params.configCacheKeyMemo,
    ),
    fsPolicy: ctx.fsPolicy ?? null,
    workspaceDir: ctx.workspaceDir ?? null,
    agentDir: ctx.agentDir ?? null,
    agentId: ctx.agentId ?? null,
    activeModel: ctx.activeModel ?? null,
    browser: ctx.browser ?? null,
    messageChannel: ctx.messageChannel ?? null,
    agentAccountId: ctx.agentAccountId ?? null,
    deliveryContext: ctx.deliveryContext ?? null,
    requesterSenderId: ctx.requesterSenderId ?? null,
    sandboxed: ctx.sandboxed ?? null,
  });
}

export function buildPluginToolDescriptorCacheKey(params: {
  pluginId: string;
  source: string;
  rootDir?: string;
  contractToolNames: readonly string[];
  ctx: OpenClawPluginToolContext;
  currentRuntimeConfig?: PluginLoadOptions["config"] | null;
  configCacheKeyMemo?: PluginToolDescriptorConfigCacheKeyMemo;
}): string {
  // Include source fingerprint and selected runtime context so descriptor reuse
  // tracks both plugin code changes and per-agent/per-channel tool visibility.
  return JSON.stringify({
    version: PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION,
    pluginId: params.pluginId,
    source: params.source,
    rootDir: params.rootDir ?? null,
    sourceFingerprint: sourceFingerprint(params.source),
    contractToolNames: [...params.contractToolNames].toSorted(),
    context: buildDescriptorContextCacheKey({
      ctx: params.ctx,
      currentRuntimeConfig: params.currentRuntimeConfig,
      configCacheKeyMemo: params.configCacheKeyMemo,
    }),
  });
}

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

export function capturePluginToolDescriptor(params: {
  pluginId: string;
  tool: AnyAgentTool;
  optional: boolean;
}): CachedPluginToolDescriptor {
  const label = (params.tool as { label?: unknown }).label;
  const title = typeof label === "string" && label.trim() ? label.trim() : undefined;
  // The descriptor is the model-facing shape; executor metadata keeps dispatch
  // pointed at the plugin-owned tool even after descriptors are cached.
  return {
    ...(params.tool.displaySummary ? { displaySummary: params.tool.displaySummary } : {}),
    optional: params.optional,
    descriptor: {
      name: params.tool.name,
      ...(title ? { title } : {}),
      description: params.tool.description,
      inputSchema: asJsonObject(params.tool.parameters),
      owner: { kind: "plugin", pluginId: params.pluginId },
      executor: { kind: "plugin", pluginId: params.pluginId, toolName: params.tool.name },
    },
  };
}

export function readCachedPluginToolDescriptors(
  cacheKey: string,
): readonly CachedPluginToolDescriptor[] | undefined {
  return descriptorCache.get(cacheKey);
}

export function writeCachedPluginToolDescriptors(params: {
  cacheKey: string;
  descriptors: readonly CachedPluginToolDescriptor[];
}): void {
  if (
    !descriptorCache.has(params.cacheKey) &&
    descriptorCache.size >= PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT
  ) {
    // Map iteration order is insertion order; deleting the first key gives a
    // tiny FIFO cap without adding request-time bookkeeping.
    const oldestKey = descriptorCache.keys().next().value;
    if (oldestKey !== undefined) {
      descriptorCache.delete(oldestKey);
    }
  }
  descriptorCache.set(params.cacheKey, [...params.descriptors]);
}
