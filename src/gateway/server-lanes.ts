import { normalizeProviderId } from "../agents/model-selection.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import type { loadConfig } from "../config/config.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg: ReturnType<typeof loadConfig>) {
  setCommandLaneConcurrency(CommandLane.Cron, cfg.cron?.maxConcurrentRuns ?? 1);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
  // Provider lanes (e.g., provider:openai, provider:google) — optional per-provider throttles.
  // Prefer simple runtime overrides under cfg.gateway.providerConcurrency to avoid
  // requiring a full models.providers catalog entry in user config.
  const providerOverrides =
    (cfg as unknown as { gateway?: { providerConcurrency?: Record<string, number> } }).gateway
      ?.providerConcurrency ?? {};
  const overrideEntries = Object.entries(providerOverrides);
  if (overrideEntries.length) {
    // eslint-disable-next-line no-console
    console.info(
      `[gateway/lanes] providerConcurrency overrides: ${overrideEntries.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`,
    );
  }
  for (const [providerIdRaw, maxRaw] of Object.entries(providerOverrides)) {
    const max = typeof maxRaw === "number" ? maxRaw : Number(maxRaw);
    if (typeof max === "number" && Number.isFinite(max) && max > 0) {
      const providerId = normalizeProviderId(String(providerIdRaw).trim());
      if (!providerId) {
        continue;
      }
      setCommandLaneConcurrency(`provider:${providerId}`, max);
    }
  }

  const providers = cfg.models?.providers ?? {};
  for (const [providerIdRaw, providerCfg] of Object.entries(providers)) {
    const max = providerCfg?.maxConcurrentRuns;
    if (typeof max === "number" && Number.isFinite(max) && max > 0) {
      const providerId = normalizeProviderId(providerIdRaw.trim());
      if (!providerId) {
        continue;
      }
      setCommandLaneConcurrency(`provider:${providerId}`, max);
    }
  }
}
