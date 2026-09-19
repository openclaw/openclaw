import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../sessions/model-overrides.js";

/** Applies the public account reset before catalog-backed model selection. */
export function applySessionsPatchAccountSelection(params: {
  next: SessionEntry;
  patch: SessionsPatchParams;
}): string | undefined {
  const { next, patch } = params;
  if (patch.authProfileId !== null) {
    return undefined;
  }
  if (isModelSelectionLocked(next)) {
    return MODEL_SELECTION_LOCKED_MESSAGE;
  }
  if (typeof patch.model === "string" && splitTrailingAuthProfile(patch.model).profile) {
    return "cannot clear and select an auth profile in the same patch";
  }
  delete next.authProfileOverride;
  delete next.authProfileOverrideSource;
  delete next.authProfileOverrideCompactionCount;
  if (next.modelFallback?.source === "agent-patch") {
    next.modelFallback = { ...next.modelFallback };
    delete next.modelFallback.prevAuthProfileOverride;
    delete next.modelFallback.prevAuthProfileOverrideSource;
    delete next.modelFallback.prevAuthProfileOverrideCompactionCount;
  }
  if (next.sessionId) {
    next.liveModelSwitchPending = true;
  }
  return undefined;
}
