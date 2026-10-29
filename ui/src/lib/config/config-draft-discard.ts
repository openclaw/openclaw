import type { AppliedConfigRefresh } from "./applied-refresh.ts";
import { resetConfigPendingChanges } from "./config-draft-model.ts";
import { loadConfig, type ConfigWriteCoordinator } from "./config-gateway-operations.ts";
import type { RuntimeConfigState } from "./config-state-model.ts";

export function createConfigDraftDiscard(context: {
  state: RuntimeConfigState;
  currentDraftRevision: () => number;
  invalidateFieldDiscards: () => void;
  hasInFlightWrite: () => boolean;
  holdAutoSave: () => (resume: boolean) => void;
  drainPendingWrites: () => Promise<void>;
  clearPatches: () => void;
  run: <T>(task: () => Promise<T>, loadKey?: "config" | "schema") => Promise<T>;
  mutate: (task: () => void) => void;
  clearDraftConnection: () => void;
  appliedRefresh: AppliedConfigRefresh;
}): ConfigWriteCoordinator["discardDraft"] {
  const { state } = context;
  const drainWrites = async (isCurrent: () => boolean) => {
    const release = context.holdAutoSave();
    try {
      if (context.hasInFlightWrite()) {
        await context.drainPendingWrites();
      }
    } finally {
      release(!isCurrent());
    }
  };
  return async (options) => {
    const revision = context.currentDraftRevision();
    const isCurrent = () => context.currentDraftRevision() === revision;
    context.invalidateFieldDiscards();
    // Settle pending writes first (with trailing saves suppressed — the
    // draft is being thrown away, not re-written) so a late ack cannot
    // re-dirty or trail-write over the discard.
    await drainWrites(isCurrent);
    // Discard owns the intent present at the click, not edits accepted while it waits.
    if (!isCurrent()) {
      return;
    }
    context.clearPatches();
    if (state.connected && state.client) {
      context.appliedRefresh.cancel();
      try {
        const loaded = await context.run(
          () => loadConfig(state, { discardPendingChanges: true }, isCurrent),
          "config",
        );
        if (loaded) {
          context.clearDraftConnection();
        }
      } finally {
        context.appliedRefresh.reconcile();
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
