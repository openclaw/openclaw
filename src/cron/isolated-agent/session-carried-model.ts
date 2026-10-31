import { hasSessionAutoModelFallbackProvenance } from "../../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../../config/sessions/types.js";

/**
 * The model selection a fresh cron session carries from the entry it copies. Inference
 * capture reads the same subset, so capture and run resolve one model and runtime.
 */
export function resolveCarriedCronModelSelection(entry: SessionEntry): Partial<SessionEntry> {
  if (entry.modelOverrideSource === "default") {
    return { modelOverrideSource: "default" };
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource === "auto" || recoveredAutoFallbackOverride) {
    return {};
  }
  const carried: Partial<SessionEntry> = {};
  if (entry.modelOverride !== undefined) {
    carried.modelOverride = entry.modelOverride;
  }
  if (entry.providerOverride !== undefined) {
    carried.providerOverride = entry.providerOverride;
  }
  if (entry.modelOverrideSource !== undefined) {
    carried.modelOverrideSource = entry.modelOverrideSource;
  }
  if (entry.modelOverrideRouteResolution !== undefined) {
    carried.modelOverrideRouteResolution = entry.modelOverrideRouteResolution;
  }
  // Runtime overrides qualify an explicit model selection; carrying one alone
  // would pin a fresh cron session to a stale engine after its model resets.
  if (entry.modelOverride !== undefined && entry.agentRuntimeOverride !== undefined) {
    carried.agentRuntimeOverride = entry.agentRuntimeOverride;
  }
  return carried;
}
