import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runAndLogPreflight } from "./preflight.js";

const log = createSubsystemLogger("gateway/preflight");

/**
 * Extract the list of distinct provider names configured in the system.
 * Includes the primary model provider and any explicit providers from config.
 */
function resolveConfiguredProviders(cfg: OpenClawConfig): string[] {
  const providers = new Set<string>();

  // Primary model provider.
  const primary = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: "",
  });
  if (primary.provider) {
    providers.add(primary.provider);
  }

  // Explicit providers from models.providers config.
  if (cfg.models?.providers) {
    for (const key of Object.keys(cfg.models.providers)) {
      if (key.trim()) {
        providers.add(key.trim());
      }
    }
  }

  return Array.from(providers);
}

/**
 * Extract fallback model refs from config for preflight validation.
 */
function resolveFallbackModelsFromConfig(
  cfg: OpenClawConfig,
): Array<{ provider: string; model: string }> {
  const fallbackRaws = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const result: Array<{ provider: string; model: string }> = [];
  for (const raw of fallbackRaws) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) {
      continue;
    }
    // Fallback format: "provider/model" or just "model" (uses default provider).
    const slashIndex = trimmed.indexOf("/");
    if (slashIndex > 0) {
      result.push({
        provider: trimmed.slice(0, slashIndex),
        model: trimmed.slice(slashIndex + 1),
      });
    } else {
      result.push({ provider: DEFAULT_PROVIDER, model: trimmed });
    }
  }
  return result;
}

/**
 * Run preflight checks at gateway startup. Non-blocking — logs results only.
 */
export function runPreflightAtStartup(params: { cfg: OpenClawConfig; agentDir?: string }): void {
  try {
    const authStore = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
    const providers = resolveConfiguredProviders(params.cfg);
    const fallbackModels = resolveFallbackModelsFromConfig(params.cfg);

    runAndLogPreflight({
      providers,
      authStore,
      fallbackModels,
    });
  } catch (err) {
    // Preflight must never block startup. Log and continue.
    log.warn(`Preflight check failed to run: ${err instanceof Error ? err.message : String(err)}`);
  }
}
