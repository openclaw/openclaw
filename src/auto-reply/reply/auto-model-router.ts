import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  resolveConfiguredModelRef,
  modelKey,
  buildConfiguredAllowlistKeys,
} from "../../agents/model-selection.js";
/**
 * Auto-model routing orchestration: in-flight dedupe, short TTL cache,
 * and optional micro-batching. Activates when selected model equals AUTO_MODEL.
 */
import type { OpenClawConfig } from "../../config/config.js";
import { AUTO_MODEL } from "../../shared/model-constants.js";

/** Re-exported for existing imports/tests. */
export { AUTO_MODEL };

export type RouterConfig = {
  /** TTL for in-flight dedupe key (ms). Same-key requests within this window share one routing call. */
  dedupeTtlMs?: number;
  /** TTL for cache entries (ms). Cached results expire after this. */
  cacheTtlMs?: number;
  /** Optional micro-batch window (ms). Requests within window can be batched. */
  microBatchMs?: number;
  /** Optional micro-batch size. When reached, flush batch. */
  microBatchSize?: number;
};

const DEFAULT_DEDUPE_TTL_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 30_000;

export type Pass1TokenUsage = {
  input?: number;
  output?: number;
  /** True when values are estimates rather than measured. */
  estimated?: boolean;
};

export type RouterResult = {
  provider: string;
  model: string;
  reason: string;
  tag: "expensive";
  pass1TokenUsage?: Pass1TokenUsage;
};

type InFlightEntry = {
  promise: Promise<RouterResult>;
  expiresAt: number;
};

type CacheEntry = {
  result: RouterResult;
  expiresAt: number;
};

type PendingBatchEntry = {
  resolve: (result: RouterResult) => void;
  reject: (error: unknown) => void;
  compute: () => Promise<RouterResult>;
};

const inFlightByKey = new Map<string, InFlightEntry>();
const cacheByKey = new Map<string, CacheEntry>();
const pendingBatch: PendingBatchEntry[] = [];
let batchFlushTimer: ReturnType<typeof setTimeout> | undefined;

function buildDedupeKey(params: {
  sessionKey?: string;
  agentId?: string;
  promptHash?: string;
}): string {
  const parts = [params.sessionKey ?? "", params.agentId ?? "", params.promptHash ?? ""];
  return parts.join("::");
}

function resolveRouterConfig(cfg: OpenClawConfig | undefined): RouterConfig {
  const raw = cfg?.agents?.defaults?.autoModelRouting?.router as RouterConfig | undefined;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  return {
    dedupeTtlMs: typeof raw.dedupeTtlMs === "number" ? raw.dedupeTtlMs : DEFAULT_DEDUPE_TTL_MS,
    cacheTtlMs: typeof raw.cacheTtlMs === "number" ? raw.cacheTtlMs : DEFAULT_CACHE_TTL_MS,
    microBatchMs: typeof raw.microBatchMs === "number" ? raw.microBatchMs : undefined,
    microBatchSize: typeof raw.microBatchSize === "number" ? raw.microBatchSize : undefined,
  };
}

function isAutoRoutingEnabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.agents?.defaults?.autoModelRouting?.enabled !== false;
}

function selectModelFromConfig(cfg: OpenClawConfig | undefined): RouterResult {
  const ref = cfg
    ? resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
  return {
    provider: ref.provider,
    model: ref.model,
    reason: "default",
    tag: "expensive",
    pass1TokenUsage: { input: 0, output: 0, estimated: true },
  };
}

function splitModelKey(key: string): { provider: string; model: string } | null {
  const slash = key.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const provider = key.slice(0, slash).trim();
  const model = key.slice(slash + 1).trim();
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function maybeSelectLocalModel(params: {
  cfg: OpenClawConfig | undefined;
  promptText?: string;
}): RouterResult | null {
  const rawPrompt = params.promptText?.toLowerCase() ?? "";
  const shouldPreferLocal =
    rawPrompt.includes("local model") ||
    rawPrompt.includes("offline") ||
    rawPrompt.includes("on-device") ||
    rawPrompt.includes("on device") ||
    rawPrompt.includes("private");
  if (!shouldPreferLocal) {
    return null;
  }
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const localKey = [...(allowlist ?? [])].find((key) => key.startsWith("ollama/"));
  if (!localKey) {
    return null;
  }
  const split = splitModelKey(localKey);
  if (!split) {
    return null;
  }
  return {
    provider: split.provider,
    model: split.model,
    reason: "local-preferred",
    tag: "expensive",
    pass1TokenUsage: { input: 0, output: 0, estimated: true },
  };
}

function isModelAvailable(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): boolean {
  const allowlist = buildConfiguredAllowlistKeys({
    cfg,
    defaultProvider: provider,
  });
  if (!allowlist || allowlist.size === 0) {
    return true;
  }
  return allowlist.has(modelKey(provider, model));
}

/**
 * Route when model is AUTO_MODEL. Uses in-flight dedupe and short TTL cache.
 * Returns chosen provider/model, reason, tag='expensive', and pass1 token usage.
 * Throws when routing fails; caller should fallback to last non-auto model.
 */
export async function routeAutoModel(params: {
  cfg: OpenClawConfig | undefined;
  promptText?: string;
  sessionKey?: string;
  agentId?: string;
  promptHash?: string;
  lastNonAutoProvider?: string;
  lastNonAutoModel?: string;
}): Promise<RouterResult> {
  const config = resolveRouterConfig(params.cfg);
  const dedupeTtlMs = config.dedupeTtlMs ?? DEFAULT_DEDUPE_TTL_MS;
  const cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = Date.now();
  const key = buildDedupeKey({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    promptHash: params.promptHash,
  });

  // Check cache first
  const cached = cacheByKey.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }
  if (cached) {
    cacheByKey.delete(key);
  }

  // In-flight dedupe: reuse existing promise for same key within TTL
  const inFlight = inFlightByKey.get(key);
  if (inFlight && inFlight.expiresAt > now) {
    return inFlight.promise;
  }
  if (inFlight) {
    inFlightByKey.delete(key);
  }

  const doRoute = async (): Promise<RouterResult> => {
    const result =
      maybeSelectLocalModel({
        cfg: params.cfg,
        promptText: params.promptText,
      }) ?? selectModelFromConfig(params.cfg);

    // If router chose a model not in allowlist, fallback to last non-auto
    if (
      params.lastNonAutoProvider &&
      params.lastNonAutoModel &&
      !isModelAvailable(params.cfg, result.provider, result.model)
    ) {
      return {
        provider: params.lastNonAutoProvider,
        model: params.lastNonAutoModel,
        reason: "fallback-unavailable",
        tag: "expensive",
        pass1TokenUsage: result.pass1TokenUsage,
      };
    }

    return result;
  };

  const microBatchMs = config.microBatchMs ?? 0;
  const microBatchSize = config.microBatchSize ?? 0;
  const promise =
    microBatchMs > 0
      ? new Promise<RouterResult>((resolve, reject) => {
          const flush = () => {
            const jobs = pendingBatch.splice(0, pendingBatch.length);
            batchFlushTimer = undefined;
            for (const job of jobs) {
              void job.compute().then(job.resolve).catch(job.reject);
            }
          };
          pendingBatch.push({
            resolve,
            reject,
            compute: doRoute,
          });
          if (pendingBatch.length >= microBatchSize && microBatchSize > 0) {
            if (batchFlushTimer) {
              clearTimeout(batchFlushTimer);
              batchFlushTimer = undefined;
            }
            flush();
            return;
          }
          if (!batchFlushTimer) {
            batchFlushTimer = setTimeout(flush, microBatchMs);
          }
        })
      : doRoute();
  inFlightByKey.set(key, {
    promise,
    expiresAt: now + dedupeTtlMs,
  });

  try {
    const result = await promise;
    cacheByKey.set(key, {
      result,
      expiresAt: now + cacheTtlMs,
    });
    return result;
  } finally {
    inFlightByKey.delete(key);
  }
}

/**
 * Resolve effective provider/model: when model is AUTO_MODEL, run router;
 * otherwise return as-is. Caller should use fallbackProvider/fallbackModel
 * when router fails.
 */
export async function resolveModelWithRouter(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  promptText?: string;
  sessionKey?: string;
  agentId?: string;
  promptHash?: string;
  lastNonAutoProvider?: string;
  lastNonAutoModel?: string;
}): Promise<
  { routed: true; result: RouterResult } | { routed: false; provider: string; model: string }
> {
  const modelNorm = String(params.model ?? "")
    .trim()
    .toLowerCase();
  if (modelNorm !== AUTO_MODEL || !isAutoRoutingEnabled(params.cfg)) {
    return {
      routed: false,
      provider: params.provider,
      model: params.model,
    };
  }

  const result = await routeAutoModel({
    cfg: params.cfg,
    promptText: params.promptText,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    promptHash: params.promptHash,
    lastNonAutoProvider: params.lastNonAutoProvider,
    lastNonAutoModel: params.lastNonAutoModel,
  });

  return { routed: true, result };
}

/** @internal – for tests */
export function _clearRouterState() {
  inFlightByKey.clear();
  cacheByKey.clear();
  pendingBatch.splice(0, pendingBatch.length);
  if (batchFlushTimer) {
    clearTimeout(batchFlushTimer);
    batchFlushTimer = undefined;
  }
}
