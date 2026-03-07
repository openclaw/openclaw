import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog, type ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { note } from "../terminal/note.js";

/**
 * Doctor check: warn when configured fallback models have significantly lower
 * capability than the primary model while still receiving full tool access.
 *
 * This does NOT block fallback — it only surfaces warnings so operators
 * are aware of the capability mismatch.
 */
export async function noteModelFailoverSafetyWarnings(cfg: OpenClawConfig) {
  const warnings: string[] = [];

  const { provider: primaryProvider, model: primaryModel } = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  const fallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  if (fallbacks.length === 0) {
    return;
  }

  let catalog: ModelCatalogEntry[];
  try {
    catalog = await loadModelCatalog({ config: cfg });
  } catch {
    // If catalog is unavailable, skip this check gracefully
    return;
  }

  const findEntry = (provider: string, model: string): ModelCatalogEntry | undefined => {
    return catalog.find(
      (e) =>
        e.provider.toLowerCase() === provider.toLowerCase() &&
        e.id.toLowerCase() === model.toLowerCase(),
    );
  };

  const primaryEntry = findEntry(primaryProvider, primaryModel);
  const primaryContextWindow = primaryEntry?.contextWindow ?? 0;
  const primaryReasoning = primaryEntry?.reasoning === true;

  // Check exec/tool configuration — are dangerous tools available?
  const execSecurity = cfg.tools?.exec?.security ?? "allowlist";
  const hasDangerousToolAccess = execSecurity !== "deny";

  if (!hasDangerousToolAccess) {
    // No dangerous tool access configured, no safety concern
    return;
  }

  for (const raw of fallbacks) {
    const parts = raw.split("/");
    const fallbackProvider = parts.length > 1 ? parts[0] : primaryProvider;
    const fallbackModel = parts.length > 1 ? parts.slice(1).join("/") : raw;
    const fallbackEntry = findEntry(fallbackProvider, fallbackModel);

    if (!fallbackEntry) {
      warnings.push(
        `- Fallback model "${raw}" not found in catalog. Cannot verify tool-use capability.`,
      );
      continue;
    }

    const concerns: string[] = [];

    // Context window significantly smaller
    if (
      primaryContextWindow > 0 &&
      fallbackEntry.contextWindow &&
      fallbackEntry.contextWindow < primaryContextWindow * 0.5
    ) {
      concerns.push(
        `context window (${fallbackEntry.contextWindow.toLocaleString()}) is less than half of primary (${primaryContextWindow.toLocaleString()})`,
      );
    }

    // Primary supports reasoning but fallback doesn't
    if (primaryReasoning && !fallbackEntry.reasoning) {
      concerns.push("does not support reasoning (primary does)");
    }

    if (concerns.length > 0) {
      warnings.push(
        `- Fallback "${raw}": ${concerns.join("; ")}. ` +
          "This model will receive the same tools as the primary model.",
      );
    }
  }

  if (warnings.length === 0) {
    return;
  }

  const lines = [
    "Fallback models with reduced capability will inherit the same tool access as the primary.",
    "Models with smaller context windows or no reasoning support may handle tool calls less reliably.",
    "",
    ...warnings,
    "",
    `Review fallback config: ${formatCliCommand("openclaw config get agents.defaults.model")}`,
  ];
  note(lines.join("\n"), "Model failover safety");
}
