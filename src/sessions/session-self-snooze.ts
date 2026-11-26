import { resolveGlobalSet } from "../shared/global-singleton.js";
import { chatRef } from "./chat-ref.js";
import type { PersistedUserTurnMessage } from "./user-turn-input.types.js";

export function isOriginalVisibleUserInput(message: PersistedUserTurnMessage) {
  return (
    message.display !== false &&
    message.excludeFromContext !== true &&
    (!message.provenance || message.provenance.kind === "external_user") &&
    message["__openclaw"]?.lateMedia !== true &&
    message["__openclaw"]?.beforeAgentRunBlocked === undefined
  );
}

export function cancelSelfSnoozeForUserInput(
  message: PersistedUserTurnMessage,
  target: Omit<Target, "storePath"> & { databasePath: string },
) {
  if (pending.size && isOriginalVisibleUserInput(message)) {
    cancelSelfSnooze({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      storePath: target.databasePath,
    });
  }
}

type Target = Parameters<typeof chatRef>[0];
type Intent = Target & { physicalStorePath?: string };

// Only live requests occupy a slot. A restart drops the intent, as for self-archive.
// After it commits, the ordinary durable sidebar snooze owns visibility and expiry.
const pending = resolveGlobalSet<Intent>(
  Symbol.for("openclaw.pendingSelfSnoozes"),
  "close-and-restart",
);

function matches(intent: Intent, target: Target) {
  return (
    intent.agentId === target.agentId &&
    intent.sessionKey === target.sessionKey &&
    (!intent.physicalStorePath ||
      intent.storePath === target.storePath ||
      intent.physicalStorePath === target.storePath)
  );
}

export function captureSelfSnooze(target: Target) {
  const intent: Intent = { ...chatRef(target) };
  pending.add(intent);
  return {
    bindStore(path: string) {
      intent.physicalStorePath = path;
      return chatRef({ ...target, storePath: path });
    },
    admit() {
      if (!pending.has(intent)) {
        throw new Error("Session snooze superseded before admission");
      }
      // The Set is in request order. An admitted replacement supersedes only older
      // requests; a rejected replacement leaves them alone.
      for (const earlier of pending) {
        if (earlier === intent) {
          break;
        }
        if (matches(earlier, target)) {
          pending.delete(earlier);
        }
      }
    },
    current: () => pending.has(intent),
    assertCurrent(this: void) {
      if (!pending.has(intent)) {
        throw new Error("Session snooze superseded by newer input or a visibility change");
      }
    },
    release: () => pending.delete(intent),
  };
}

/** Accepting input invalidates its intent before yielding the writer lane. While the
 * tool resolves its physical store, an ambiguous same-chat input wins conservatively. */
export function cancelSelfSnooze(target: Target) {
  for (const intent of pending) {
    if (matches(intent, target)) {
      pending.delete(intent);
    }
  }
}
