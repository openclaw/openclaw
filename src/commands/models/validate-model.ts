import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog, type ModelCatalogEntry } from "../../agents/model-catalog.js";
import { modelKey, parseModelRef } from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";

/**
 * Bounded Levenshtein distance for fuzzy model suggestions.
 * Returns null if the distance exceeds maxDistance.
 */
function boundedLevenshtein(a: string, b: string, maxDistance: number): number | null {
  if (a === b) {
    return 0;
  }
  if (!a || !b) {
    return null;
  }
  const aLen = a.length;
  const bLen = b.length;
  if (Math.abs(aLen - bLen) > maxDistance) {
    return null;
  }

  const prev = Array.from({ length: bLen + 1 }, (_, idx) => idx);
  const curr = Array.from({ length: bLen + 1 }, () => 0);

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) {
        rowMin = curr[j];
      }
    }
    if (rowMin > maxDistance) {
      return null;
    }
    for (let j = 0; j <= bLen; j++) {
      prev[j] = curr[j] ?? 0;
    }
  }

  const dist = prev[bLen] ?? null;
  if (dist == null || dist > maxDistance) {
    return null;
  }
  return dist;
}

/**
 * Find similar models in the catalog for "did you mean?" suggestions.
 */
function findSimilarModels(
  modelId: string,
  provider: string,
  catalog: ModelCatalogEntry[],
  maxSuggestions = 3,
): string[] {
  const normalizedModel = modelId.toLowerCase();
  const normalizedProvider = provider.toLowerCase();
  const maxDistance = Math.max(3, Math.floor(modelId.length * 0.4));

  const scored: Array<{ key: string; distance: number }> = [];

  for (const entry of catalog) {
    const entryProvider = entry.provider.toLowerCase();
    const entryModel = entry.id.toLowerCase();

    // Prefer same-provider matches
    if (entryProvider === normalizedProvider) {
      const dist = boundedLevenshtein(normalizedModel, entryModel, maxDistance);
      if (dist !== null && dist > 0) {
        scored.push({ key: modelKey(entry.provider, entry.id), distance: dist });
      }
    }

    // Also check cross-provider: exact model name match or close match
    if (entryProvider !== normalizedProvider) {
      if (entryModel === normalizedModel) {
        // Exact model name, wrong provider — very likely what they meant
        scored.push({ key: modelKey(entry.provider, entry.id), distance: 1 });
      } else {
        const crossDist = boundedLevenshtein(normalizedModel, entryModel, maxDistance);
        if (crossDist !== null && crossDist > 0) {
          scored.push({ key: modelKey(entry.provider, entry.id), distance: crossDist + 2 });
        }
      }
    }
  }

  scored.sort((a, b) => a.distance - b.distance);
  const seen = new Set<string>();
  const results: string[] = [];
  for (const item of scored) {
    if (seen.has(item.key)) {
      continue;
    }
    seen.add(item.key);
    results.push(item.key);
    if (results.length >= maxSuggestions) {
      break;
    }
  }
  return results;
}

export type ModelValidationResult =
  | { valid: true; key: string }
  | { valid: false; message: string };

/**
 * Validate a model ID against the available model catalog.
 * Returns a validation result with a user-friendly error message on failure.
 */
export async function validateModelAgainstCatalog(
  modelRaw: string,
): Promise<ModelValidationResult> {
  const parsed = parseModelRef(modelRaw, DEFAULT_PROVIDER);
  if (!parsed) {
    return {
      valid: false,
      message: `Invalid model reference: "${modelRaw}". Expected format: "provider/model" (e.g., "anthropic/claude-sonnet-4-5").`,
    };
  }

  const { provider, model } = parsed;
  const key = modelKey(provider, model);

  let catalog: ModelCatalogEntry[];
  try {
    catalog = await loadModelCatalog();
  } catch {
    // If catalog isn't available, allow the model through with a warning.
    return { valid: true, key };
  }

  if (catalog.length === 0) {
    // No catalog loaded (possibly no auth configured yet). Allow through.
    return { valid: true, key };
  }

  // Check for exact match (case-insensitive).
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = model.toLowerCase();
  const exactMatch = catalog.find(
    (entry) =>
      entry.provider.toLowerCase() === normalizedProvider &&
      entry.id.toLowerCase() === normalizedModel,
  );

  if (exactMatch) {
    return { valid: true, key: modelKey(exactMatch.provider, exactMatch.id) };
  }

  // No match found. Build a helpful error message.
  const suggestions = findSimilarModels(model, provider, catalog);
  const lines: string[] = [`Model "${key}" not found in the available model catalog.`, ""];

  if (suggestions.length > 0) {
    lines.push("Did you mean one of these?");
    for (const suggestion of suggestions) {
      lines.push(`  - ${suggestion}`);
    }
    lines.push("");
  }

  lines.push(`Run ${formatCliCommand("openclaw models list")} to see all available models.`);

  return { valid: false, message: lines.join("\n") };
}
