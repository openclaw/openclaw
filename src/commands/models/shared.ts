import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  buildModelAliasIndex,
  modelKey,
  parseModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  type OpenClawConfig,
  readConfigFileSnapshot,
  writeConfigFile,
} from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";

export const ensureFlagCompatibility = (opts: { json?: boolean; plain?: boolean }) => {
  if (opts.json && opts.plain) {
    throw new Error("Choose either --json or --plain, not both.");
  }
};

export const formatTokenK = (value?: number | null) => {
  if (!value || !Number.isFinite(value)) return "-";
  if (value < 1024) return `${Math.round(value)}`;
  return `${Math.round(value / 1024)}k`;
};

export const formatMs = (value?: number | null) => {
  if (value === null || value === undefined) return "-";
  if (!Number.isFinite(value)) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${Math.round(value / 100) / 10}s`;
};

export async function updateConfig(
  mutator: (cfg: OpenClawConfig) => OpenClawConfig,
): Promise<OpenClawConfig> {
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.valid) {
    const issues = snapshot.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Invalid config at ${snapshot.path}\n${issues}`);
  }
  const next = mutator(snapshot.config);
  await writeConfigFile(next);
  return next;
}

export function resolveModelTarget(params: { raw: string; cfg: OpenClawConfig }): {
  provider: string;
  model: string;
} {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolved = resolveModelRefFromString({
    raw: params.raw,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
  });
  if (!resolved) {
    throw new Error(`Invalid model reference: ${params.raw}`);
  }
  return resolved.ref;
}

export function buildAllowlistSet(cfg: OpenClawConfig): Set<string> {
  const allowed = new Set<string>();
  const models = cfg.agents?.defaults?.models ?? {};
  for (const raw of Object.keys(models)) {
    const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
    if (!parsed) continue;
    allowed.add(modelKey(parsed.provider, parsed.model));
  }
  return allowed;
}

export function normalizeAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) throw new Error("Alias cannot be empty.");
  if (!/^[A-Za-z0-9_.:-]+$/.test(trimmed)) {
    throw new Error("Alias must use letters, numbers, dots, underscores, colons, or dashes.");
  }
  return trimmed;
}

export function resolveKnownAgentId(params: {
  cfg: OpenClawConfig;
  rawAgentId?: string | null;
}): string | undefined {
  const raw = params.rawAgentId?.trim();
  if (!raw) return undefined;
  const agentId = normalizeAgentId(raw);
  const knownAgents = listAgentIds(params.cfg);
  if (!knownAgents.includes(agentId)) {
    throw new Error(
      `Unknown agent id "${raw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
    );
  }
  return agentId;
}

export { modelKey };
export { DEFAULT_MODEL, DEFAULT_PROVIDER };

/**
 * Model key format: "provider/model"
 *
 * The model key is displayed in `/model status` and used to reference models.
 * When using `/model <key>`, use the exact format shown (e.g., "openrouter/moonshotai/kimi-k2").
 *
 * For providers with hierarchical model IDs (e.g., OpenRouter), the model ID may include
 * sub-providers (e.g., "moonshotai/kimi-k2"), resulting in a key like "openrouter/moonshotai/kimi-k2".
 */

import {
  findModelInCatalog,
  loadModelCatalog,
  type ModelCatalogEntry,
  modelSupportsVision,
} from "../../agents/model-catalog.js";

export type ModelValidationResult = {
  valid: boolean;
  entry?: ModelCatalogEntry;
  suggestions?: string[];
};

/**
 * Validate that a model exists in the catalog.
 * Returns suggestions for similar models if not found.
 * Gracefully degrades if catalog fails to load.
 */
export async function validateModelInCatalog(
  provider: string,
  modelId: string,
): Promise<ModelValidationResult> {
  try {
    const catalog = await loadModelCatalog();
    if (catalog.length === 0) {
      // Catalog unavailable - gracefully degrade
      return { valid: true };
    }

    const entry = findModelInCatalog(catalog, provider, modelId);
    if (entry) {
      return { valid: true, entry };
    }

    // Find suggestions via fuzzy matching
    const suggestions = findSimilarModels(catalog, provider, modelId);
    return { valid: false, suggestions };
  } catch {
    // Catalog load failed - gracefully degrade
    return { valid: true };
  }
}

/**
 * Validate that a model exists and supports vision input.
 */
export async function validateImageModel(
  provider: string,
  modelId: string,
): Promise<ModelValidationResult & { supportsVision?: boolean }> {
  const result = await validateModelInCatalog(provider, modelId);
  if (!result.valid || !result.entry) {
    return result;
  }
  return {
    ...result,
    supportsVision: modelSupportsVision(result.entry),
  };
}

function findSimilarModels(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): string[] {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();

  // Score models by similarity
  const scored = catalog
    .map((entry) => {
      const entryProvider = entry.provider.toLowerCase();
      const entryModelId = entry.id.toLowerCase();

      let score = 0;

      // Boost same-provider matches
      if (entryProvider === normalizedProvider) {
        score += 50;
      }

      // Calculate string similarity for model ID
      score += stringSimilarity(normalizedModelId, entryModelId);

      return { key: `${entry.provider}/${entry.id}`, score };
    })
    .filter((item) => item.score > 30) // Minimum threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return scored.map((item) => item.key);
}

function stringSimilarity(a: string, b: string): number {
  // Simple Levenshtein-based similarity score
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 100;
  const distance = levenshteinDistance(a, b);
  return Math.round((1 - distance / maxLen) * 100);
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1,
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
