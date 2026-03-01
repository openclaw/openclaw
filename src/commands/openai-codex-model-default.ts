import type { OpenClawConfig } from "../config/config.js";
// @see src/commands/model-default.ts for patchAgentDefaultModel and resolvePrimaryModel
import { patchAgentDefaultModel, resolvePrimaryModel } from "./model-default.js";

export const OPENAI_CODEX_DEFAULT_MODEL = "openai-codex/gpt-5.3-codex";

function shouldSetOpenAICodexModel(model?: string): boolean {
  const trimmed = model?.trim();
  if (!trimmed) {
    return true;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized.startsWith("openai-codex/")) {
    return false;
  }
  if (normalized.startsWith("openai/")) {
    return true;
  }
  return normalized === "gpt" || normalized === "gpt-mini";
}

export function applyOpenAICodexModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const current = resolvePrimaryModel(cfg.agents?.defaults?.model);
  if (!shouldSetOpenAICodexModel(current)) {
    return { next: cfg, changed: false };
  }
  return {
    next: patchAgentDefaultModel(cfg, { primary: OPENAI_CODEX_DEFAULT_MODEL }),
    changed: true,
  };
}
