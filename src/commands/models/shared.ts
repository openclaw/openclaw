import { listAgentIds } from "../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildCatalogKeySet,
  sanitizeConfiguredModelIds,
  sanitizeSingleModelId,
} from "../../agents/model-sanitization.js";
import {
  buildModelAliasIndex,
  modelKey,
  parseModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
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
  if (!value || !Number.isFinite(value)) {
    return "-";
  }
  if (value < 1024) {
    return `${Math.round(value)}`;
  }
  return `${Math.round(value / 1024)}k`;
};

export const formatMs = (value?: number | null) => {
  if (value === null || value === undefined) {
    return "-";
  }
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value < 1000) {
    return `${Math.round(value)}ms`;
  }
  return `${Math.round(value / 100) / 10}s`;
};

export const isLocalBaseUrl = (baseUrl: string) => {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
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

  // Sanitize configured model IDs before persisting
  const sanitized = await sanitizeConfigModelIds(next);
  await writeConfigFile(sanitized);
  return sanitized;
}

/**
 * Sanitize configured model IDs in the config against the current catalog.
 * This ensures stale/nonexistent model IDs are never persisted.
 */
async function sanitizeConfigModelIds(cfg: OpenClawConfig): Promise<OpenClawConfig> {
  const catalog = await loadModelCatalog({ config: cfg, useCache: true });
  if (catalog.length === 0) {
    return cfg;
  }

  const catalogKeys = buildCatalogKeySet(catalog);
  let result = cfg;

  // Sanitize agents.defaults.models (allowlist keys)
  const models = cfg.agents?.defaults?.models;
  if (models && Object.keys(models).length > 0) {
    const keys = Object.keys(models);
    const sanitizeResult = sanitizeConfiguredModelIds(keys, catalogKeys);

    if (sanitizeResult.removed.length > 0 || sanitizeResult.repaired.length > 0) {
      const newModels: typeof models = {};

      for (const key of sanitizeResult.configured) {
        const repairedEntry = sanitizeResult.repaired.find((r) => r.to === key);
        const originalKey = repairedEntry?.from ?? key;
        const value = models[originalKey];
        if (value !== undefined) {
          newModels[key] = value;
        }
      }

      result = {
        ...result,
        agents: {
          ...result.agents,
          defaults: {
            ...result.agents?.defaults,
            models: newModels,
          },
        },
      };

      for (const repair of sanitizeResult.repaired) {
        console.warn(`[model-sanitization] Repaired model ID: ${repair.from} -> ${repair.to}`);
      }
      for (const removed of sanitizeResult.removed) {
        console.warn(`[model-sanitization] Removed stale model ID: ${removed}`);
      }
    }
  }

  // Sanitize agents.defaults.model.primary
  const modelConfig = cfg.agents?.defaults?.model as
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  if (modelConfig?.primary) {
    const primaryResult = sanitizeSingleModelId(modelConfig.primary, catalogKeys);
    if (primaryResult.id !== modelConfig.primary) {
      if (primaryResult.repaired) {
        console.warn(
          `[model-sanitization] Repaired primary model: ${primaryResult.repaired.from} -> ${primaryResult.repaired.to}`,
        );
      } else if (primaryResult.id === null) {
        console.warn(`[model-sanitization] Removed stale primary model: ${modelConfig.primary}`);
      }

      result = {
        ...result,
        agents: {
          ...result.agents,
          defaults: {
            ...result.agents?.defaults,
            model: {
              ...modelConfig,
              primary: primaryResult.id ?? undefined,
            },
          },
        },
      };
    }
  }

  // Sanitize agents.defaults.model.fallbacks
  if (modelConfig?.fallbacks && modelConfig.fallbacks.length > 0) {
    const fallbacksResult = sanitizeConfiguredModelIds(modelConfig.fallbacks, catalogKeys);
    if (fallbacksResult.removed.length > 0 || fallbacksResult.repaired.length > 0) {
      for (const repair of fallbacksResult.repaired) {
        console.warn(
          `[model-sanitization] Repaired fallback model: ${repair.from} -> ${repair.to}`,
        );
      }
      for (const removed of fallbacksResult.removed) {
        console.warn(`[model-sanitization] Removed stale fallback model: ${removed}`);
      }

      const currentModel = result.agents?.defaults?.model as
        | { primary?: string; fallbacks?: string[] }
        | undefined;

      result = {
        ...result,
        agents: {
          ...result.agents,
          defaults: {
            ...result.agents?.defaults,
            model: {
              ...currentModel,
              fallbacks:
                fallbacksResult.configured.length > 0 ? fallbacksResult.configured : undefined,
            },
          },
        },
      };
    }
  }

  return result;
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

export function resolveModelKeysFromEntries(params: {
  cfg: OpenClawConfig;
  entries: readonly string[];
}): string[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  return params.entries
    .map((entry) =>
      resolveModelRefFromString({
        raw: entry,
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
      }),
    )
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => modelKey(entry.ref.provider, entry.ref.model));
}

export function buildAllowlistSet(cfg: OpenClawConfig): Set<string> {
  const allowed = new Set<string>();
  const models = cfg.agents?.defaults?.models ?? {};
  for (const raw of Object.keys(models)) {
    const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
    if (!parsed) {
      continue;
    }
    allowed.add(modelKey(parsed.provider, parsed.model));
  }
  return allowed;
}

export function normalizeAlias(alias: string): string {
  const trimmed = alias.trim();
  if (!trimmed) {
    throw new Error("Alias cannot be empty.");
  }
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
  if (!raw) {
    return undefined;
  }
  const agentId = normalizeAgentId(raw);
  const knownAgents = listAgentIds(params.cfg);
  if (!knownAgents.includes(agentId)) {
    throw new Error(
      `Unknown agent id "${raw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
    );
  }
  return agentId;
}

export type PrimaryFallbackConfig = { primary?: string; fallbacks?: string[] };

export function mergePrimaryFallbackConfig(
  existing: PrimaryFallbackConfig | undefined,
  patch: { primary?: string; fallbacks?: string[] },
): PrimaryFallbackConfig {
  const next: PrimaryFallbackConfig = { ...existing };
  if (patch.primary !== undefined) {
    next.primary = patch.primary;
  }
  if (patch.fallbacks !== undefined) {
    next.fallbacks = patch.fallbacks;
  }
  return next;
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
