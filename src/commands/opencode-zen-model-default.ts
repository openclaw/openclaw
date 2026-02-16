import type { SmartAgentNeoConfig } from "../config/config.js";
import { applyAgentDefaultPrimaryModel } from "./model-default.js";

export const OPENCODE_ZEN_DEFAULT_MODEL = "opencode/claude-opus-4-6";
const LEGACY_OPENCODE_ZEN_DEFAULT_MODELS = new Set([
  "opencode/claude-opus-4-5",
  "opencode-zen/claude-opus-4-5",
]);

export function applyOpencodeZenModelDefault(cfg: SmartAgentNeoConfig): {
  next: SmartAgentNeoConfig;
  changed: boolean;
} {
  return applyAgentDefaultPrimaryModel({
    cfg,
    model: OPENCODE_ZEN_DEFAULT_MODEL,
    legacyModels: LEGACY_OPENCODE_ZEN_DEFAULT_MODELS,
  });
}
