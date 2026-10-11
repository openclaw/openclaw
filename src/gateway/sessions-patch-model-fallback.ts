import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";

/** Apply the preference after the canonical model writer; return a validation error, if any. */
export function applyModelFallbackPolicyPatch(entry: SessionEntry, patch: SessionsPatchParams) {
  if ("modelFallbackPolicy" in patch && !("model" in patch)) {
    if (patch.modelFallbackPolicy === "configured") {
      if (!entry.modelOverride || entry.modelOverrideSource !== "user") {
        return "modelFallbackPolicy requires an explicit session model selection";
      }
      entry.modelFallbackPolicy = "configured";
    } else {
      delete entry.modelFallbackPolicy;
    }
  }
  if (entry.modelFallbackPolicy === "configured") {
    // Fallback success or auth failure must not replace the requested preference.
    delete entry.modelFallback;
  }
  return undefined;
}
