import type { OpenClawConfig } from "../config/config.js";
import { applyAgentDefaultPrimaryModel } from "./model-default.js";

export const OPENCODE_GO_DEFAULT_MODEL = "opencode-go/glm-5";
const LEGACY_OPENCODE_GO_DEFAULT_MODELS = new Set<string>([]);

export function applyOpencodeGoModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  return applyAgentDefaultPrimaryModel({
    cfg,
    model: OPENCODE_GO_DEFAULT_MODEL,
    legacyModels: LEGACY_OPENCODE_GO_DEFAULT_MODELS,
  });
}
