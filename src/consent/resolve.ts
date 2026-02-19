/**
 * Resolve ConsentGate API from gateway config.
 * Returns no-op when consentGate is disabled or not configured.
 */

import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { ConsentGateApi } from "./api.js";
import { createNoOpConsentGateApi } from "./api.js";
import { createConsentEngine } from "./engine.js";
import { createConsentMetrics } from "./metrics.js";
import type { TokenStore } from "./store.js";
import { createFileBackedTokenStore } from "./store-file.js";
import { createInMemoryTokenStore } from "./store.js";
import type { WalWriter } from "./wal.js";
import { createFileBackedWal } from "./wal-file.js";
import { createInMemoryWal } from "./wal.js";

/** Default tool/command names that require consent when ConsentGate is enabled. */
export const DEFAULT_CONSENT_GATED_TOOLS = [
  "exec",
  "write",
  "gateway",
  "sessions_spawn",
  "sessions_send",
  "whatsapp_login",
  "skills.install",
  "system.run",
] as const;

const POLICY_VERSION = "1";

/** Lazy singleton per process (gateway typically has one config). */
let cachedApi: ConsentGateApi | null = null;
let cachedConfigKey: string | null = null;
let cachedRuntime:
  | {
      key: string;
      store: TokenStore;
      wal: WalWriter;
      metrics: ReturnType<typeof createConsentMetrics>;
      quarantine: Set<string>;
    }
  | null = null;

function configKey(cfg: OpenClawConfig): string {
  const cg = cfg.gateway?.consentGate;
  if (!cg?.enabled) return "off";
  return [
    "on",
    cg.observeOnly ?? true,
    (cg.gatedTools ?? []).join(","),
    cg.storagePath ?? "",
  ].join("|");
}

function runtimeStateKey(storagePath: string | undefined): string {
  const trimmed = storagePath?.trim();
  if (!trimmed) return "memory";
  return `file:${path.resolve(trimmed)}`;
}

function resolveRuntimeState(storagePath: string | undefined): {
  store: TokenStore;
  wal: WalWriter;
  metrics: ReturnType<typeof createConsentMetrics>;
  quarantine: Set<string>;
} {
  const key = runtimeStateKey(storagePath);
  if (cachedRuntime && cachedRuntime.key === key) {
    return cachedRuntime;
  }
  const trimmed = storagePath?.trim();
  const store = trimmed
    ? createFileBackedTokenStore(trimmed)
    : createInMemoryTokenStore();
  const wal = trimmed ? createFileBackedWal(trimmed) : createInMemoryWal();
  const metrics = createConsentMetrics();
  const quarantine = new Set<string>();
  cachedRuntime = {
    key,
    store,
    wal,
    metrics,
    quarantine,
  };
  return cachedRuntime;
}

/**
 * Get ConsentGate API for the current config.
 * When consentGate.enabled is false or missing, returns no-op (always allow, no WAL).
 */
export function resolveConsentGateApi(cfg: OpenClawConfig): ConsentGateApi {
  const key = configKey(cfg);
  if (cachedConfigKey === key && cachedApi) {
    return cachedApi;
  }
  const cg = cfg.gateway?.consentGate;
  if (!cg?.enabled) {
    cachedApi = createNoOpConsentGateApi();
    cachedConfigKey = key;
    return cachedApi;
  }
  const runtime = resolveRuntimeState(cg.storagePath);
  const tierToolMatrix = cg.tierToolMatrix && typeof cg.tierToolMatrix === "object" ? cg.tierToolMatrix : undefined;
  const rateLimit =
    cg.rateLimit &&
    typeof cg.rateLimit.maxOpsPerWindow === "number" &&
    typeof cg.rateLimit.windowMs === "number" &&
    cg.rateLimit.maxOpsPerWindow > 0 &&
    cg.rateLimit.windowMs > 0
      ? { maxOpsPerWindow: cg.rateLimit.maxOpsPerWindow, windowMs: cg.rateLimit.windowMs }
      : undefined;
  const engine = createConsentEngine({
    store: runtime.store,
    wal: runtime.wal,
    policyVersion: POLICY_VERSION,
    metrics: runtime.metrics,
    quarantine: runtime.quarantine,
    tierToolMatrix,
    rateLimit,
  });
  cachedApi = Object.assign(engine, {
    getMetrics: () => runtime.metrics.getSnapshot(),
    liftQuarantine: (sessionKey: string) => runtime.quarantine.delete(sessionKey),
  });
  cachedConfigKey = key;
  return cachedApi;
}

/**
 * Test-only cache reset so unit tests can isolate module-level runtime state.
 */
export function resetConsentGateResolverForTests(): void {
  cachedApi = null;
  cachedConfigKey = null;
  cachedRuntime = null;
}

/**
 * Return the set of tool names that require consent for this config.
 * Empty when ConsentGate is disabled.
 */
export function resolveConsentGatedTools(cfg: OpenClawConfig): Set<string> {
  const cg = cfg.gateway?.consentGate;
  if (!cg?.enabled) return new Set();
  const list = cg.gatedTools ?? [...DEFAULT_CONSENT_GATED_TOOLS];
  return new Set(list);
}

/**
 * Whether ConsentGate is in observe-only mode (log only, do not block).
 */
export function isConsentGateObserveOnly(cfg: OpenClawConfig): boolean {
  const cg = cfg.gateway?.consentGate;
  if (!cg?.enabled) return true;
  return cg.observeOnly ?? true;
}

/**
 * Resolve trust tier from config for a given session key.
 * Uses longest matching prefix from trustTierMapping, else trustTierDefault (default "T0").
 */
export function resolveTrustTier(cfg: OpenClawConfig, sessionKey: string): string {
  const cg = cfg.gateway?.consentGate;
  const mapping = cg?.trustTierMapping;
  const defaultTier = (cg?.trustTierDefault?.trim() || "T0").toUpperCase();
  if (!mapping || typeof mapping !== "object") {
    return defaultTier;
  }
  let bestPrefix = "";
  let bestTier = defaultTier;
  for (const [prefix, tier] of Object.entries(mapping)) {
    if (typeof prefix !== "string" || typeof tier !== "string") continue;
    const p = prefix.trim();
    const t = tier.trim();
    if (!p) continue;
    if (sessionKey === p || sessionKey.startsWith(p + ":") || sessionKey.startsWith(p)) {
      if (p.length > bestPrefix.length) {
        bestPrefix = p;
        bestTier = t;
      }
    }
  }
  return bestTier || defaultTier;
}
