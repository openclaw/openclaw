/** Caches plugin tool descriptors by plugin source, contract names, and runtime context. */
import fs from "node:fs";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import { evaluateToolAvailability } from "../tools/availability.js";
import type {
  JsonObject,
  ToolAvailabilityExpression,
  ToolDescriptor,
} from "../tools/types.js";
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

function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}

/**
 * Validates that availability expression group fields are arrays before the
 * evaluator iterates them.  Plugin-authored data is untyped at this boundary;
 * a non-array {@code allOf} / {@code anyOf} value would reach
 * {@code evaluateExpression} and throw on {@code .flatMap} / {@code .map},
 * crashing tool registration.
 */
function hasValidAvailabilityGroupShape(
  expr: ToolAvailabilityExpression,
): boolean {
  if ("allOf" in expr) {
    return Array.isArray(expr.allOf);
  }
  if ("anyOf" in expr) {
    return Array.isArray(expr.anyOf);
  }
  // kind-based expressions don't have group fields — always valid
  return true;
}

export function capturePluginToolDescriptor(params: {
  pluginId: string;
  tool: AnyAgentTool;
  optional: boolean;
}): CachedPluginToolDescriptor {
  const label = (params.tool as { label?: unknown }).label;
  const title = typeof label === "string" && label.trim() ? label.trim() : undefined;

  // Preserve tool-authored availability expressions so descriptor-driven
  // planning can enforce them.  Read through a narrowed record so the
  // descriptor cache stays decoupled from the agent-tool type contract.
  const rawAvailability = (params.tool as { availability?: unknown })
    .availability;
  let availability: ToolAvailabilityExpression | undefined =
    rawAvailability !== undefined &&
    typeof rawAvailability === "object" &&
    rawAvailability !== null &&
    !Array.isArray(rawAvailability) &&
    ("kind" in rawAvailability ||
      "allOf" in rawAvailability ||
      "anyOf" in rawAvailability)
      ? (rawAvailability as ToolAvailabilityExpression)
      : undefined;

  // Defensive shape guard: plugin-authored availability is untyped at this
  // boundary.  Non-array allOf / anyOf values would reach the evaluator and
  // throw on .flatMap / .map, crashing tool registration.  Diagnose and
  // strip the malformed expression so the evaluator stays pure.
  if (availability && !hasValidAvailabilityGroupShape(availability)) {
    console.warn(
      `[plugins] tool descriptor authoring error (${params.pluginId}/${params.tool.name}): ` +
        `Non-array availability group — allOf/anyOf values must be arrays`,
    );
    availability = undefined;
  }

  const descriptor: ToolDescriptor = {
    name: params.tool.name,
    ...(title ? { title } : {}),
    description: params.tool.description,
    inputSchema: asJsonObject(params.tool.parameters),
    owner: { kind: "plugin", pluginId: params.pluginId },
    executor: { kind: "plugin", pluginId: params.pluginId, toolName: params.tool.name },
    ...(availability ? { availability } : {}),
  };

  // Surface malformed availability at descriptor-registration time
  // (once per captured descriptor) so plugin authors see authoring
  // errors immediately.  Only unsupported-signal diagnostics are
  // authoring-time concerns; runtime conditions (auth, config, env)
  // are evaluated later with a real context.
  if (availability) {
    const diagnostics = evaluateToolAvailability({ descriptor });
    for (const diag of diagnostics) {
      if (diag.reason === "unsupported-signal") {
        console.warn(
          `[plugins] tool descriptor authoring error (${params.pluginId}/${params.tool.name}): ${diag.message}`,
        );
      }
    }
  }

  return {
    ...(params.tool.displaySummary ? { displaySummary: params.tool.displaySummary } : {}),
    optional: params.optional,
    descriptor,
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
