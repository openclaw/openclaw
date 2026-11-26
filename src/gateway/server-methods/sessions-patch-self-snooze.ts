import type { SessionEntry } from "../../config/sessions.js";
import { cancelSelfSnooze } from "../../sessions/session-self-snooze.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { PreparedPatchTarget } from "./sessions-patch-types.js";

// A deferred agent write settles its own intent. It is not a new sidebar choice
// and must not cancel a later request. Never accept this marker over the wire.
const deferred = resolveGlobalSingleton<WeakSet<object>>(
  Symbol.for("openclaw.deferredSelfSnoozePatches"),
  () => new WeakSet(),
);

export function bindDeferredSelfSnoozePatch<T extends object>(params: T): T {
  deferred.add(params);
  return params;
}

// A valid sidebar choice wins at commit, including an explicit wake of an awake row.
export function cancelSupersededSnooze(
  target: PreparedPatchTarget,
  entry: SessionEntry,
  { deferredSelfSnooze }: { deferredSelfSnooze?: boolean },
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
      sessionId: entry.sessionId,
    });
  }
}

export function isDeferredSelfSnoozePatch(params: object): boolean {
  return deferred.has(params);
}
