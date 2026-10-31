import { resolveGlobalMap } from "../shared/global-singleton.js";

// Display-only pending facts span persistence and runtime acknowledgement, including
// the gap between interrupted and replacement attempts. They never grant authority.
const pendingChanges = resolveGlobalMap<string, symbol>(
  Symbol.for("openclaw.sessionPermissionChanges"),
  "close-and-restart",
);

export function beginSessionPermissionChange(sessionId: string): () => void {
  const owner = Symbol("session permission change");
  pendingChanges.set(sessionId, owner);
  return () => {
    if (pendingChanges.get(sessionId) === owner) {
      pendingChanges.delete(sessionId);
    }
  };
}

export function isSessionPermissionChangePending(sessionId: string | undefined): boolean {
  return sessionId !== undefined && pendingChanges.has(sessionId);
}
