import type { ChatRef } from "../../sessions/chat-ref.js";
import { cancelSelfSnooze } from "../../sessions/session-self-snooze.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PreparedPatchTarget } from "./sessions-patch-types.js";

// A deferred agent write settles its own intent. It is not a new sidebar choice
// and must not cancel a later request. Never accept this marker over the wire.
const deferred = resolveGlobalSingleton<WeakMap<object, ChatRef>>(
  Symbol.for("openclaw.deferredSelfSnoozePatches"),
  () => new WeakMap(),
);

export function bindDeferredSelfSnoozePatch<T extends object>(params: T, chat: ChatRef): T {
  deferred.set(params, chat);
  return params;
}

// A valid sidebar choice wins at commit, including an explicit wake of an awake row.
export function cancelSupersededSnooze(
  target: PreparedPatchTarget,
  { deferredSelfSnooze }: { deferredSelfSnooze?: ChatRef },
) {
  const patch = target.fullPatch;
  if (
    !deferredSelfSnooze &&
    (patch.snoozedUntil !== undefined || patch.archived === true || patch.pinned === true)
  ) {
    cancelSelfSnooze({
      agentId: target.targetAgentId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
    });
  }
}

export function getDeferredSelfSnoozeChat(params: object) {
  return deferred.get(params);
}
