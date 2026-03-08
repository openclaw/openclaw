import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { resolveModelRefFromString } from "../agents/model-selection.js";
import type { loadConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";

/**
 * Find the best matching model name suggestion for an unrecognized model,
 * using prefix matching within the same provider.
 */
function findClosestModelSuggestion(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): string | undefined {
  const normalizedProvider = provider.toLowerCase().trim();
  const normalizedModelId = modelId.toLowerCase().trim();

  // Restrict candidates to the same provider first.
  const providerModels = catalog.filter(
    (entry) => entry.provider.toLowerCase() === normalizedProvider,
  );

  let bestMatch: ModelCatalogEntry | undefined;
  let bestPrefixLen = 0;

  for (const entry of providerModels) {
    const entryId = entry.id.toLowerCase();
    let prefixLen = 0;
    const minLen = Math.min(normalizedModelId.length, entryId.length);
    for (let i = 0; i < minLen; i++) {
      if (normalizedModelId[i] === entryId[i]) {
        prefixLen++;
      } else {
        break;
      }
    }
    if (prefixLen > bestPrefixLen) {
      bestPrefixLen = prefixLen;
      bestMatch = entry;
    }
  }

  // Only suggest if there's a meaningful prefix overlap (> 3 chars to avoid noise).
  if (bestMatch && bestPrefixLen > 3) {
    return `${bestMatch.provider}/${bestMatch.id}`;
  }

  return undefined;
}

/**
 * Validate that primary and fallback model names in the config exist in the
 * model catalog.  Emits a clear warning for each unrecognized model so the
 * user can fix typos early (e.g. "google/gemini-3-pro" vs the real
 * "google/gemini-3-pro-preview").
 *
 * This is intentionally non-fatal: custom / local model names that are not
 * yet in the catalog should not break startup.
 */
export async function validateConfiguredModelNames(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  try {
    const catalog = await loadModelCatalog({ config: params.cfg });
    if (catalog.length === 0) {
      // Cannot validate without a populated catalog — skip silently.
      return;
    }

    const agentModel = params.cfg.agents?.defaults?.model;
    const primaryRaw = resolveAgentModelPrimaryValue(agentModel);
    const fallbackRaws = resolveAgentModelFallbackValues(agentModel);

    const modelsToCheck: Array<{ raw: string; role: string }> = [];
    if (primaryRaw) {
      modelsToCheck.push({ raw: primaryRaw, role: "Primary model" });
    }
    for (const fb of fallbackRaws) {
      const trimmed = (fb ?? "").trim();
      if (trimmed) {
        modelsToCheck.push({ raw: trimmed, role: "Fallback model" });
      }
    }

    for (const { raw, role } of modelsToCheck) {
      const resolved = resolveModelRefFromString({
        raw,
        defaultProvider: DEFAULT_PROVIDER,
      });
      if (!resolved) {
        continue;
      }

      const { provider, model: modelId } = resolved.ref;
      const inCatalog = catalog.some(
        (entry) =>
          entry.provider.toLowerCase() === provider.toLowerCase() &&
          entry.id.toLowerCase() === modelId.toLowerCase(),
      );

      if (!inCatalog) {
        const suggestion = findClosestModelSuggestion(catalog, provider, modelId);
        const suggestionText = suggestion ? ` Did you mean "${suggestion}"?` : "";
        params.log.warn(
          `[config-warn] ${role} "${provider}/${modelId}" is not recognized.${suggestionText} Run \`openclaw models list\` for valid names.`,
        );
      }
    }
  } catch (err) {
    // Never let validation failures break startup.
    params.log.warn(`[config-warn] Model name validation skipped: ${String(err)}`);
  }
}
