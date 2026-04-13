import type { OpenClawConfig } from "../config/config.js";
import type { AgentModelListConfig } from "../config/types.js";
import { ensureModelAllowlistEntry } from "./model-allowlist.js";

export const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.4";
export const OPENAI_CODEX_DEFAULT_FALLBACKS = ["openai-codex/gpt-5.2"] as const;
const OPENAI_CODEX_LEGACY_DEFAULT_MODELS = new Set([
  "openai-codex/gpt-5.2",
  "openai-codex/gpt-5.2-codex",
  "openai-codex/gpt-5.3-codex",
  "openai-codex/gpt-5.1-codex",
]);

function shouldSetOpenAICodexModel(model?: string): boolean {
  const trimmed = model?.trim();
  if (!trimmed) {
    return true;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("openai-codex/")) {
    return (
      normalized !== OPENAI_CODEX_DEFAULT_MODEL &&
      OPENAI_CODEX_LEGACY_DEFAULT_MODELS.has(normalized)
    );
  }
  if (normalized.startsWith("openai/")) {
    return true;
  }
  return normalized === "gpt" || normalized === "gpt-mini";
}

function resolvePrimaryModel(model?: AgentModelListConfig | string): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  if (model && typeof model === "object" && typeof model.primary === "string") {
    return model.primary;
  }
  return undefined;
}

function resolveFallbackModels(model?: AgentModelListConfig | string): string[] {
  if (!model || typeof model !== "object" || !Array.isArray(model.fallbacks)) {
    return [];
  }
  return model.fallbacks
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .filter((entry) => entry !== OPENAI_CODEX_DEFAULT_MODEL);
}

function buildFallbackModels(model?: AgentModelListConfig | string): string[] {
  return [...new Set([...OPENAI_CODEX_DEFAULT_FALLBACKS, ...resolveFallbackModels(model)])];
}

export function applyOpenAICodexModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const currentModelConfig = cfg.agents?.defaults?.model;
  const current = resolvePrimaryModel(currentModelConfig);
  if (!shouldSetOpenAICodexModel(current)) {
    return { next: cfg, changed: false };
  }
  const fallbacks = buildFallbackModels(currentModelConfig);
  let next = ensureModelAllowlistEntry({
    cfg,
    modelRef: OPENAI_CODEX_DEFAULT_MODEL,
  });
  for (const fallback of fallbacks) {
    next = ensureModelAllowlistEntry({
      cfg: next,
      modelRef: fallback,
    });
  }
  return {
    next: {
      ...next,
      agents: {
        ...next.agents,
        defaults: {
          ...next.agents?.defaults,
          model: {
            primary: OPENAI_CODEX_DEFAULT_MODEL,
            ...(fallbacks.length > 0 ? { fallbacks } : undefined),
          },
        },
      },
    },
    changed: true,
  };
}
