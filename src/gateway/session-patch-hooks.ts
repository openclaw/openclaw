import type { SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hasInternalHookListeners,
  triggerInternalHook,
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
} from "../hooks/internal-hooks.js";

/** Emit the internal session.patch hook after a Gateway session entry changes. */
export function triggerSessionPatchHook(params: {
  /** Current config snapshot exposed to hook listeners. */
  cfg: OpenClawConfig;
  /** Patched session entry after validation and normalization. */
  sessionEntry: SessionEntry;
  /** Canonical session store key for the patched entry. */
  sessionKey: string;
  /** Original Gateway patch payload that produced the entry. */
  patch: SessionsPatchParams;
}): void {
  if (!hasInternalHookListeners("session", "patch")) {
    return;
  }

  // Hook listeners are best-effort observers; clone the patch context so a listener
  // cannot mutate the persisted session entry or config snapshot by reference.
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
