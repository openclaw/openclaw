import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ExitRegistration = { close: () => void };
type ExitCleanupGroup = {
  pending: Set<ExitRegistration>;
  dispatch: () => void;
};
const cleanupState = resolveGlobalSingleton(
  Symbol.for("openclaw.processExitCleanup"),
  (): { lastGroup?: ExitCleanupGroup } => ({}),
);

function detachEmptyGroup(group: ExitCleanupGroup): void {
  if (group.pending.size > 0) {
    return;
  }
  if (cleanupState.lastGroup === group) {
    cleanupState.lastGroup = undefined;
  }
  process.removeListener("exit", group.dispatch);
}

/**
 * Register synchronous best-effort cleanup in registration order. Orderly teardown
 * must unregister it; adjacent owners share a process listener.
 */
export function registerProcessExitCleanup(closeAll: () => void): () => void {
  const registration = { close: closeAll };
  let group = cleanupState.lastGroup;
  // Preserve intervening owners, such as capture finalization before database close.
  if (!group || process.listeners("exit").at(-1) !== group.dispatch) {
    const pending = new Set([registration]);
    const created: ExitCleanupGroup = {
      pending,
      dispatch: () => {
        // Snapshot this batch before callbacks; disposal cannot skip an admitted close.
        const snapshot = [...pending];
        pending.clear();
        detachEmptyGroup(created);
        for (const entry of snapshot) {
          try {
            entry.close();
          } catch {
            // One failed cleanup must not prevent the remaining owners from retiring.
          }
        }
      },
    };
    process.on("exit", created.dispatch);
    cleanupState.lastGroup = group = created;
  } else {
    group.pending.add(registration);
  }
  const owner = group;
  return () => {
    owner.pending.delete(registration);
    detachEmptyGroup(owner);
  };
}
