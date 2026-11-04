// Publishes internal mutation notifications after Gateway session patch calls.
import {
  createInternalHookEvent,
  hasInternalHookListeners,
  triggerInternalHook,
  type SessionPatchHookContext,
  type SessionPatchHookEvent,
} from "../hooks/internal-hooks.js";

// Session patch hooks are fire-and-forget internal hooks. The context is cloned
// so hook listeners cannot mutate the live session entry or patch object.
export function triggerSessionPatchHook(
  params: SessionPatchHookContext & Pick<SessionPatchHookEvent, "sessionKey">,
): void {
  if (!hasInternalHookListeners("session", "patch")) {
    return;
  }

  const hookContext: SessionPatchHookContext = structuredClone({
    sessionEntry: params.sessionEntry,
    patch: params.patch,
    cfg: params.cfg,
  });
  const hookEvent = createInternalHookEvent("session", "patch", params.sessionKey, hookContext);
  void triggerInternalHook(hookEvent);
}
