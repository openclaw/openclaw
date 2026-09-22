/** Session lifecycle event broadcast to observers when a session is created or linked. */
import { resolveGlobalSet } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
export type SessionLifecycleEvent = {
  sessionKey: string;
  agentId?: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
} & (
  | { reason: string; swarmGroupId?: never; kind?: never; text?: never }
  | { reason: "swarm-note"; swarmGroupId: string; kind: "phase" | "log"; text: string }
);

export type SessionIdentityMutationTarget = {
  sessionId?: string;
  sessionKeys: readonly string[];
};

export type SessionIdentityMutation = {
  /** Resolved operation scope for bare keys; qualified keys retain their own agent. */
  agentId: string;
} & (
  | {
      kind: "create" | "move" | "replace" | "reset";
      previous: SessionIdentityMutationTarget;
      current: SessionIdentityMutationTarget;
    }
  | {
      kind: "delete";
      previous: SessionIdentityMutationTarget;
    }
);

export type SessionIdentityMutationListener = (mutation: SessionIdentityMutation) => void;

type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;

const SESSION_LIFECYCLE_LISTENERS = resolveGlobalSet<SessionLifecycleListener>(
  Symbol.for("openclaw.sessionLifecycleEventListeners"),
  "close-and-restart",
);
const SESSION_IDENTITY_MUTATION_LISTENERS = resolveGlobalSet<SessionIdentityMutationListener>(
  Symbol.for("openclaw.sessionIdentityMutationListeners"),
  "close-and-restart",
);
/** Registers a session lifecycle listener. */
export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  return registerListener(SESSION_LIFECYCLE_LISTENERS, listener);
}

/** Emits a best-effort session lifecycle event to all listeners. */
export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  notifyListeners(SESSION_LIFECYCLE_LISTENERS, event);
}

export function onSessionIdentityMutation(listener: SessionIdentityMutationListener): () => void {
  return registerListener(SESSION_IDENTITY_MUTATION_LISTENERS, listener);
}

export function emitSessionIdentityMutation(mutation: SessionIdentityMutation): void {
  notifyListeners(SESSION_IDENTITY_MUTATION_LISTENERS, mutation);
}
