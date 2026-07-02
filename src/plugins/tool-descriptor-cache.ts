/** Caches plugin tool descriptors by plugin source, contract names, and runtime context. */
import fs from "node:fs";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import type { JsonObject, ToolDescriptor } from "../tools/types.js";
import type { PluginLoadOptions } from "./loader.js";
import type { OpenClawPluginToolContext } from "./types.js";

const PLUGIN_TOOL_DESCRIPTOR_CACHE_VERSION = 1;
const PLUGIN_TOOL_DESCRIPTOR_CACHE_LIMIT = 256;

/** Cached display descriptor for one plugin-created tool. */
export type CachedPluginToolDescriptor = {
  descriptor: ToolDescriptor;
  displaySummary?: string;
  optional: boolean;
};

const descriptorCache = new Map<string, CachedPluginToolDescriptor[]>();
let descriptorCacheObjectIds = new WeakMap<object, number>();
let nextDescriptorCacheObjectId = 1;

export type PluginToolDescriptorConfigCacheKeyMemo = WeakMap<object, string | number | null>;

/** Creates a memo table for config cache keys reused across descriptor cache calls. */
export function createPluginToolDescriptorConfigCacheKeyMemo(): PluginToolDescriptorConfigCacheKeyMemo {
  return new WeakMap();
}

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

type ToolDescriptorFieldRead =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | { readonly ok: false };

function readToolDescriptorField(
  tool: AnyAgentTool,
  field: keyof AnyAgentTool | "label" | "displaySummary",
): ToolDescriptorFieldRead {
  try {
    return { ok: true, value: (tool as Record<string, unknown>)[field] };
  } catch {
    return { ok: false };
  }
}

function readOptionalDescriptorString(
  tool: AnyAgentTool,
  field: "label" | "displaySummary",
): string | undefined {
  const fieldRead = readToolDescriptorField(tool, field);
  return fieldRead.ok && typeof fieldRead.value === "string" && fieldRead.value.trim()
    ? fieldRead.value.trim()
    : undefined;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

export function capturePluginToolDescriptor(params: {
  pluginId: string;
  tool: AnyAgentTool;
  optional: boolean;
}): CachedPluginToolDescriptor | undefined {
  const nameRead = readToolDescriptorField(params.tool, "name");
  const parametersRead = readToolDescriptorField(params.tool, "parameters");
  if (!nameRead.ok || typeof nameRead.value !== "string" || !nameRead.value.trim()) {
    return undefined;
  }
  const inputSchema = parametersRead.ok ? asJsonObject(parametersRead.value) : undefined;
  if (!inputSchema) {
    return undefined;
  }
  const name = nameRead.value.trim();
  const descriptionRead = readToolDescriptorField(params.tool, "description");
  if (!descriptionRead.ok || typeof descriptionRead.value !== "string") {
    return undefined;
  }
  const title = readOptionalDescriptorString(params.tool, "label");
  const displaySummary = readOptionalDescriptorString(params.tool, "displaySummary");
  return {
    ...(displaySummary ? { displaySummary } : {}),
    optional: params.optional,
    descriptor: {
      name,
      ...(title ? { title } : {}),
      description: descriptionRead.value,
      inputSchema,
      owner: { kind: "plugin", pluginId: params.pluginId },
      executor: { kind: "plugin", pluginId: params.pluginId, toolName: name },
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
    const oldestKey = descriptorCache.keys().next().value;
    if (oldestKey !== undefined) {
      descriptorCache.delete(oldestKey);
    }
  }
  descriptorCache.set(params.cacheKey, [...params.descriptors]);
}
