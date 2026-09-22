import { resetConfigPendingChanges } from "./config-draft-model.ts";
import { loadConfig, type ConfigWriteCoordinator } from "./config-gateway-operations.ts";
import type { RuntimeConfigState } from "./config-state-model.ts";

export function createConfigDraftDiscard(context: {
  state: RuntimeConfigState;
  invalidateFieldDiscards: () => void;
  hasInFlightWrite: () => boolean;
  holdAutoSave: () => (resume: boolean) => void;
  drainPendingWrites: () => Promise<void>;
  clearPatches: () => void;
  run: <T>(task: () => Promise<T>, loadKey?: "config" | "schema") => Promise<T>;
  mutate: (task: () => void) => void;
  clearDraftConnection: () => void;
  cancelAppliedRefresh: () => void;
  reconcileAppliedRefresh: () => void;
}): ConfigWriteCoordinator["discardDraft"] {
  const { state } = context;
  const drainWrites = async () => {
    const release = context.holdAutoSave();
    try {
      if (context.hasInFlightWrite()) {
        await context.drainPendingWrites();
      }
    } finally {
      release(false);
    }
    context.clearPatches();
  };
  return async (options) => {
    context.invalidateFieldDiscards();
    // Settle pending writes first (with trailing saves suppressed — the
    // draft is being thrown away, not re-written) so a late ack cannot
    // re-dirty or trail-write over the discard.
    await drainWrites();
    if (state.connected && state.client) {
      context.cancelAppliedRefresh();
      try {
        const loaded = await context.run(
          () => loadConfig(state, { discardPendingChanges: true }),
          "config",
        );
        if (loaded) {
          context.clearDraftConnection();
        }
      } finally {
        context.reconcileAppliedRefresh();
      }
      return;
    }
    if (options?.reloadOnly || state.configRecoveryError !== null) {
      return;
    }
    // Offline: a network refresh would silently no-op and strand the
    // draft; fall back to a pure local reset onto the snapshot originals.
    context.mutate(() => {
      resetConfigPendingChanges(state);
      // Conflict marks the snapshot itself stale; an offline reset onto
      // those stale originals must NOT pretend to have reconciled — only a
      // connected reload clears conflict (same invariant as elsewhere).
      if (state.configAutoSaveStatus !== "conflict") {
        state.configAutoSaveStatus = "idle";
        state.lastError = null;
      }
    });
    context.clearDraftConnection();
  };
}
