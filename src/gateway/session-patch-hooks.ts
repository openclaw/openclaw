import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasInternalHookListeners,
  triggerInternalHook,
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
} from "../hooks/internal-hooks.js";

/** Emits cloned session patch context to internal hooks after persisted session updates. */
export function triggerSessionPatchHook(params: {
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry;
  sessionKey: string;
  patch: SessionsPatchParams;
}): void {
  if (!hasInternalHookListeners("session", "patch")) {
    return;
  }

  // Clone mutable session/patch data before async hook delivery so listeners see
  // the persisted patch snapshot, not later in-process mutations of the entry.
  const hookContext: SessionPatchHookContext = structuredClone({
    sessionEntry: params.sessionEntry,
    patch: params.patch,
    cfg: params.cfg,
  });
  const hookEvent: SessionPatchHookEvent = {
    type: "session",
    action: "patch",
    sessionKey: params.sessionKey,
    context: hookContext,
    timestamp: new Date(),
    messages: [],
  };
  void triggerInternalHook(hookEvent);
}
