import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeModelRef } from "../agents/model-selection.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { isVitestRuntimeEnv } from "../infra/env.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export type CachedPricingTier = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** [startTokens, endTokens) — half-open interval on the input token axis. */
  range: [number, number];
};

export type CachedModelPricing = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Optional tiered pricing tiers sourced from LiteLLM or local config. */
  tieredPricing?: CachedPricingTier[];
};

let cachedPricing = new Map<string, CachedModelPricing>();
let cachedAt = 0;

function modelPricingCacheKey(provider: string, model: string): string {
  const providerId = normalizeProviderId(provider);
  const modelId = model.trim();
  if (!providerId || !modelId) {
    return "";
  }
  return normalizeLowercaseStringOrEmpty(modelId).startsWith(
    `${normalizeLowercaseStringOrEmpty(providerId)}/`,
  )
    ? modelId
    : `${providerId}/${modelId}`;
}

export function replaceGatewayModelPricingCache(
  nextPricing: Map<string, CachedModelPricing>,
  nextCachedAt = Date.now(),
): void {
  cachedPricing = nextPricing;
  cachedAt = nextCachedAt;
}

export function clearGatewayModelPricingCacheState(): void {
  cachedPricing = new Map();
  cachedAt = 0;
}

export function getCachedGatewayModelPricing(params: {
  provider?: string;
  model?: string;
}): CachedModelPricing | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const key = modelPricingCacheKey(provider, model);
  const direct = key ? cachedPricing.get(key) : undefined;
  if (direct) {
    return direct;
  }
  const normalized = normalizeModelRef(provider, model);
  const normalizedKey = modelPricingCacheKey(normalized.provider, normalized.model);
  if (normalizedKey === key) {
    return undefined;
  }
  return normalizedKey ? cachedPricing.get(normalizedKey) : undefined;
}

export function getGatewayModelPricingCacheMeta(): {
  cachedAt: number;
  ttlMs: number;
  size: number;
} {
  return {
    cachedAt,
    ttlMs: 0,
    size: cachedPricing.size,
  };
}

// ---------------------------------------------------------------------------
// Disk cache — persist pricing across gateway restarts
// ---------------------------------------------------------------------------

const DISK_CACHE_VERSION = 1;

type DiskCachePayload = {
  version: number;
  cachedAt: number;
  data: Record<string, CachedModelPricing>;
};

type DiskCacheResult = {
  pricing: Map<string, CachedModelPricing>;
  cachedAt: number;
};

function getPricingCacheDir(): string {
  // Use the same home-dir resolution as the rest of openclaw: respects
  // process.env.HOME and OPENCLAW_HOME overrides (important for test isolation).
  const homeDir = resolveRequiredHomeDir(process.env, os.homedir);
  return path.join(homeDir, ".openclaw", "cache");
}

function getPricingCacheFilePath(source: "openrouter" | "litellm"): string {
  return path.join(getPricingCacheDir(), `${source}-pricing.json`);
}

function isValidCachedModelPricing(value: unknown): value is CachedModelPricing {
  if (!value || typeof value !== "object") {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.input === "number" &&
    typeof v.output === "number" &&
    typeof v.cacheRead === "number" &&
    typeof v.cacheWrite === "number"
  );
}

export async function loadPricingCacheFromDisk(
  source: "openrouter" | "litellm",
): Promise<DiskCacheResult | null> {
  // Disk cache is disabled in test environments to prevent cross-test pollution.
  if (isVitestRuntimeEnv()) {
    return null;
  }
  const filePath = getPricingCacheFilePath(source);
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).version !== DISK_CACHE_VERSION
    ) {
      return null;
    }
    const payload = parsed as DiskCachePayload;
    if (typeof payload.cachedAt !== "number" || !payload.data || typeof payload.data !== "object") {
      return null;
    }
    const pricing = new Map<string, CachedModelPricing>();
    for (const [key, entry] of Object.entries(payload.data)) {
      if (isValidCachedModelPricing(entry)) {
        pricing.set(key, entry);
      }
    }
    return { pricing, cachedAt: payload.cachedAt };
  } catch {
    return null;
  }
}

export async function savePricingCacheToDisk(
  source: "openrouter" | "litellm",
  pricing: Map<string, CachedModelPricing>,
  cachedAt: number,
): Promise<void> {
  // Disk cache writes are suppressed in test environments.
  if (isVitestRuntimeEnv()) {
    return;
  }
  const cacheDir = getPricingCacheDir();
  const filePath = getPricingCacheFilePath(source);
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  const payload: DiskCachePayload = {
    version: DISK_CACHE_VERSION,
    cachedAt,
    data: Object.fromEntries(pricing.entries()),
  };
  try {
    await fs.promises.mkdir(cacheDir, { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(payload), "utf8");
    await fs.promises.rename(tmpPath, filePath);
  } catch {
    // Disk cache write failures are non-fatal — gateway continues without persistence.
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
  }
}

export function __resetGatewayModelPricingCacheForTest(): void {
  clearGatewayModelPricingCacheState();
}

export function __setGatewayModelPricingForTest(
  entries: Array<{ provider: string; model: string; pricing: CachedModelPricing }>,
): void {
  replaceGatewayModelPricingCache(
    new Map(
      entries.flatMap((entry) => {
        const normalized = normalizeModelRef(entry.provider, entry.model, {
          allowPluginNormalization: false,
        });
        const key = modelPricingCacheKey(normalized.provider, normalized.model);
        return key ? ([[key, entry.pricing]] as const) : [];
      }),
    ),
  );
}
