import crypto from "node:crypto";
import { getLogger } from "../../logging/logger.js";
import {
  createMem0ApiAdapter,
  type Mem0Adapter,
  type Mem0StoreParams,
  type MemoryRecallResult,
} from "./adapter.js";

const logger = getLogger();

const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_RECALL_THRESHOLD = 0.75;
const DEFAULT_CAPTURE_ENABLED = true;
const MAX_CAPTURED_TEXT = 700;
const DEFAULT_INJECT_MAX_ITEMS = 5;
const DEFAULT_INJECT_MAX_CHARS = 1_200;
const DEFAULT_INJECT_ITEM_MAX_CHARS = 240;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const DEFAULT_INJECT_MAX_ESTIMATED_TOKENS = 320;
const DEFAULT_STORE_DEDUPE_WINDOW_MS = 5 * 60_000;
const DEFAULT_CIRCUIT_OPEN_MS = 60_000;

type Mem0PocConfig = {
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  recallLimit: number;
  recallThreshold: number;
  captureEnabled: boolean;
  injectMaxItems: number;
  injectMaxChars: number;
  injectItemMaxChars: number;
  injectMaxEstimatedTokens: number;
  storeDedupeWindowMs: number;
  circuitOpenMs: number;
};

type RecallContext = {
  query: string;
  userId?: string;
  agentId?: string;
  runId?: string;
};

type CaptureContext = {
  userMessage: string;
  assistantMessage: string;
  toolSummary?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
};

type RecallInjectResult = {
  injectedText?: string;
  recalledCount: number;
};

type CircuitStatus = "closed" | "open" | "half-open";

type CircuitState = {
  status: CircuitStatus;
  openedAtMs: number;
  openedReason?: string;
  checkedAtMs: number;
};

const circuitState: CircuitState = {
  status: "closed",
  openedAtMs: 0,
  openedReason: undefined,
  checkedAtMs: 0,
};

let adapterCache: Mem0Adapter | null = null;
let adapterCacheKey: string | null = null;
const storeDedupeCache = new Map<string, number>();

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function readNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function readFloat(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function readMem0Config(env: NodeJS.ProcessEnv = process.env): Mem0PocConfig {
  return {
    enabled: isTrue(env.MEM0_ENABLED),
    baseUrl: env.MEM0_BASE_URL?.trim() || undefined,
    apiKey: env.MEM0_API_KEY?.trim() || undefined,
    recallLimit: readNumber(env.MEM0_RECALL_LIMIT, DEFAULT_RECALL_LIMIT, 1, 20),
    recallThreshold: readFloat(env.MEM0_RECALL_THRESHOLD, DEFAULT_RECALL_THRESHOLD, 0, 1),
    captureEnabled: env.MEM0_CAPTURE_ENABLED
      ? isTrue(env.MEM0_CAPTURE_ENABLED)
      : DEFAULT_CAPTURE_ENABLED,
    injectMaxItems: readNumber(env.MEM0_INJECT_MAX_ITEMS, DEFAULT_INJECT_MAX_ITEMS, 1, 20),
    injectMaxChars: readNumber(env.MEM0_INJECT_MAX_CHARS, DEFAULT_INJECT_MAX_CHARS, 120, 8_000),
    injectItemMaxChars: readNumber(
      env.MEM0_INJECT_ITEM_MAX_CHARS,
      DEFAULT_INJECT_ITEM_MAX_CHARS,
      60,
      1_500,
    ),
    injectMaxEstimatedTokens: readNumber(
      env.MEM0_INJECT_MAX_ESTIMATED_TOKENS,
      DEFAULT_INJECT_MAX_ESTIMATED_TOKENS,
      32,
      2_000,
    ),
    storeDedupeWindowMs: readNumber(
      env.MEM0_STORE_DEDUPE_WINDOW_MS,
      DEFAULT_STORE_DEDUPE_WINDOW_MS,
      1_000,
      24 * 60 * 60_000,
    ),
    circuitOpenMs: readNumber(
      env.MEM0_CIRCUIT_OPEN_MS,
      DEFAULT_CIRCUIT_OPEN_MS,
      1_000,
      60 * 60_000,
    ),
  };
}

function isConfigured(cfg: Mem0PocConfig): boolean {
  return cfg.enabled && Boolean(cfg.baseUrl) && Boolean(cfg.apiKey);
}

function getAdapter(cfg: Mem0PocConfig): Mem0Adapter | null {
  if (!isConfigured(cfg)) {
    return null;
  }
  const key = `${cfg.baseUrl}|${cfg.apiKey}`;
  if (!adapterCache || adapterCacheKey !== key) {
    adapterCache = createMem0ApiAdapter({
      baseUrl: cfg.baseUrl!,
      apiKey: cfg.apiKey!,
    });
    adapterCacheKey = key;
  }
  return adapterCache;
}

function estimateTokensByChars(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function markCircuitClosed(): void {
  if (circuitState.status !== "closed") {
    logger.info("[mem0-health] circuit closed; mem0 PoC re-enabled");
  }
  circuitState.status = "closed";
  circuitState.openedAtMs = 0;
  circuitState.openedReason = undefined;
  circuitState.checkedAtMs = Date.now();
}

function markCircuitOpen(reason: string): void {
  const now = Date.now();
  const wasOpen = circuitState.status === "open";
  circuitState.status = "open";
  circuitState.openedAtMs = now;
  circuitState.openedReason = reason;
  circuitState.checkedAtMs = now;
  if (wasOpen) {
    logger.warn(`[mem0-health] circuit remains open: ${reason}`);
    return;
  }
  logger.warn(`[mem0-health] circuit opened: ${reason}`);
}

function pruneStoreDedupeCache(now: number, windowMs: number): void {
  if (storeDedupeCache.size === 0) {
    return;
  }
  for (const [key, ts] of storeDedupeCache) {
    if (now - ts > windowMs) {
      storeDedupeCache.delete(key);
    }
  }
}

function computeStoreFingerprint(params: CaptureContext): string {
  const normalized = [
    params.userId ?? "",
    params.agentId ?? "",
    params.userMessage.trim().toLowerCase(),
    params.assistantMessage.trim().toLowerCase(),
    params.toolSummary?.trim().toLowerCase() ?? "",
  ].join("\n");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function shouldSkipStoreAsDuplicate(params: CaptureContext, windowMs: number): boolean {
  const now = Date.now();
  pruneStoreDedupeCache(now, windowMs);
  const key = computeStoreFingerprint(params);
  const lastTs = storeDedupeCache.get(key);
  if (typeof lastTs === "number" && now - lastTs <= windowMs) {
    return true;
  }
  storeDedupeCache.set(key, now);
  return false;
}

async function ensureHealthy(cfg: Mem0PocConfig): Promise<boolean> {
  if (!isConfigured(cfg)) {
    return false;
  }
  const now = Date.now();
  if (circuitState.status === "open") {
    const elapsed = now - circuitState.openedAtMs;
    if (elapsed < cfg.circuitOpenMs) {
      return false;
    }
    circuitState.status = "half-open";
    logger.info("[mem0-health] circuit half-open; probing health");
  }
  const adapter = getAdapter(cfg);
  if (!adapter) {
    return false;
  }
  try {
    const healthy = await adapter.healthCheck();
    if (healthy) {
      markCircuitClosed();
      logger.info("[mem0-health] health check passed");
      return true;
    }
    markCircuitOpen("health check failed");
    return false;
  } catch (error) {
    markCircuitOpen(
      `health check error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

function stableScoreFilter(results: MemoryRecallResult[], threshold: number): MemoryRecallResult[] {
  return results.filter((item) => item.score == null || item.score >= threshold);
}

function dedupeRecallText(results: MemoryRecallResult[]): MemoryRecallResult[] {
  const seen = new Set<string>();
  const deduped: MemoryRecallResult[] = [];
  for (const item of results) {
    const key = item.text.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function truncateRecallItems(
  results: MemoryRecallResult[],
  itemMaxChars: number,
): MemoryRecallResult[] {
  return results
    .map((item) => {
      const trimmed = item.text.trim();
      if (!trimmed) {
        return undefined;
      }
      const text =
        trimmed.length <= itemMaxChars
          ? trimmed
          : `${trimmed.slice(0, Math.max(1, itemMaxChars - 3))}...`;
      return { ...item, text };
    })
    .filter((item): item is MemoryRecallResult => Boolean(item));
}

function formatRecallInjectBlock(results: MemoryRecallResult[]): string | undefined {
  if (results.length === 0) {
    return undefined;
  }
  const lines = results.map((item) => `- ${item.text}`);
  return `Relevant long-term memory:\n${lines.join("\n")}`;
}

function capInjectBlock(params: {
  results: MemoryRecallResult[];
  maxItems: number;
  maxChars: number;
  maxEstimatedTokens: number;
}): { selected: MemoryRecallResult[]; injectedText?: string } {
  const selected: MemoryRecallResult[] = [];
  for (const item of params.results.slice(0, params.maxItems)) {
    const next = [...selected, item];
    const block = formatRecallInjectBlock(next);
    if (!block) {
      continue;
    }
    const tokenEstimate = estimateTokensByChars(block);
    if (block.length > params.maxChars || tokenEstimate > params.maxEstimatedTokens) {
      break;
    }
    selected.push(item);
  }
  return {
    selected,
    injectedText: formatRecallInjectBlock(selected),
  };
}

function isLikelyNoise(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) {
    return true;
  }
  if (trimmed.length <= 3) {
    return true;
  }
  return /^(ok|okay|thanks|thank you|hi|hello|bye|good night|收到|好的|谢谢)$/.test(trimmed);
}

function clampText(text: string, maxChars = MAX_CAPTURED_TEXT): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...`;
}

function buildCaptureMemory(params: CaptureContext): string | undefined {
  const user = params.userMessage.trim();
  const assistant = params.assistantMessage.trim();
  if (!user || !assistant) {
    return undefined;
  }
  if (isLikelyNoise(user) && isLikelyNoise(assistant)) {
    return undefined;
  }
  const lines: string[] = [
    `User: ${clampText(user, 280)}`,
    `Assistant: ${clampText(assistant, 380)}`,
  ];
  if (params.toolSummary?.trim()) {
    lines.push(`Tool summary: ${clampText(params.toolSummary.trim(), 200)}`);
  }
  return lines.join("\n");
}

export async function recallAndBuildInjectText(
  params: RecallContext,
): Promise<RecallInjectResult | undefined> {
  const cfg = readMem0Config();
  if (!isConfigured(cfg)) {
    return undefined;
  }
  if (!(await ensureHealthy(cfg))) {
    return undefined;
  }
  const adapter = getAdapter(cfg);
  if (!adapter) {
    return undefined;
  }
  try {
    const recallRaw = await adapter.recall({
      query: params.query,
      userId: params.userId,
      agentId: params.agentId,
      runId: params.runId,
      limit: cfg.recallLimit,
      threshold: cfg.recallThreshold,
    });
    const filtered = truncateRecallItems(
      dedupeRecallText(stableScoreFilter(recallRaw, cfg.recallThreshold)),
      cfg.injectItemMaxChars,
    );
    const { selected, injectedText } = capInjectBlock({
      results: filtered,
      maxItems: cfg.injectMaxItems,
      maxChars: cfg.injectMaxChars,
      maxEstimatedTokens: cfg.injectMaxEstimatedTokens,
    });
    const injectEstimatedTokens = injectedText ? estimateTokensByChars(injectedText) : 0;
    logger.info(
      `[mem0-recall] recalled=${recallRaw.length} selected=${selected.length} inject_chars=${injectedText?.length ?? 0} inject_est_tokens=${injectEstimatedTokens}`,
    );
    return {
      injectedText,
      recalledCount: recallRaw.length,
    };
  } catch (error) {
    markCircuitOpen(`recall error: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn(
      `[mem0-recall] recall failed; skip inject: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

export async function captureLongTermMemory(params: CaptureContext): Promise<void> {
  const cfg = readMem0Config();
  if (!isConfigured(cfg) || !cfg.captureEnabled) {
    return;
  }
  if (!(await ensureHealthy(cfg))) {
    return;
  }
  const adapter = getAdapter(cfg);
  if (!adapter) {
    return;
  }
  const memory = buildCaptureMemory(params);
  if (!memory) {
    logger.info("[mem0-store] skipped capture due to noise filter");
    return;
  }
  if (shouldSkipStoreAsDuplicate(params, cfg.storeDedupeWindowMs)) {
    logger.info("[mem0-store] skipped duplicate capture within dedupe window");
    return;
  }
  const payload: Mem0StoreParams = {
    memory,
    userMessage: params.userMessage,
    assistantMessage: params.assistantMessage,
    toolSummary: params.toolSummary,
    userId: params.userId,
    agentId: params.agentId,
    runId: params.runId,
  };
  try {
    await adapter.store(payload);
    logger.info("[mem0-store] success=true");
  } catch (error) {
    markCircuitOpen(`store error: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn(
      `[mem0-store] success=false error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const __mem0TestHooks = {
  resetState(): void {
    adapterCache = null;
    adapterCacheKey = null;
    storeDedupeCache.clear();
    circuitState.status = "closed";
    circuitState.openedAtMs = 0;
    circuitState.openedReason = undefined;
    circuitState.checkedAtMs = 0;
  },
};
