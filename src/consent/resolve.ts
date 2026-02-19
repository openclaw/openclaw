/**
 * Resolve ConsentGate API from gateway config.
 * Returns no-op when consentGate is disabled or not configured.
 */

import type { OpenClawConfig } from "../config/types.js";
import type { ConsentGateApi } from "./api.js";
import { createNoOpConsentGateApi } from "./api.js";
import { createConsentEngine } from "./engine.js";
import { createInMemoryTokenStore } from "./store.js";
import { createInMemoryWal, createNoOpWal } from "./wal.js";

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
  const store = createInMemoryTokenStore();
  const wal = createInMemoryWal();
  cachedApi = createConsentEngine({
    store,
    wal,
    policyVersion: POLICY_VERSION,
  });
  cachedConfigKey = key;
  return cachedApi;
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
