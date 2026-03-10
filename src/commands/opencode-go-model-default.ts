import { OPENCODE_GO_DEFAULT_MODEL_REF as AGENT_OPENCODE_GO_DEFAULT_MODEL_REF } from "../agents/opencode-go-models.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyAgentDefaultPrimaryModel } from "./model-default.js";

export const OPENCODE_GO_DEFAULT_MODEL_REF = AGENT_OPENCODE_GO_DEFAULT_MODEL_REF;

export function applyOpencodeGoModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  return applyAgentDefaultPrimaryModel({ cfg, model: OPENCODE_GO_DEFAULT_MODEL_REF });
}
