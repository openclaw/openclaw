import { createDeferredCore, type Deferred } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { createConfigDraftDiscard } from "./config-draft-discard.ts";
import {
  removeConfigFormValue,
  stageDefaultAgentConfigEntry,
  updateConfigFormValue,
  updateConfigRawValue,
} from "./config-draft-model.ts";
import { createConfigFieldDiscard } from "./config-field-discard.ts";
import {
  executeConfigExternalMutation,
  loadConfig,
  refreshDraft,
  refreshConfigAfterMutation,
  submitConfigDraft,
  type ConfigSubmissionObserver,
  type ConfigWriteCoordinator,
  type ConfigMethod,
  type ConfigWriteCoordinatorContext,
  type RuntimeConfigExternalMutationOptions,
  type RuntimeConfigExternalMutationResult,
} from "./config-gateway-operations.ts";
import { createConfigPatchCoordinator } from "./config-patch-coordinator.ts";
import {
  currentConfigConnectionEpoch,
  currentConfigRead,
  invalidateConfigConnection,
  isCurrentConfigConnection,
  nextRequestVersion,
  resolveEditableSnapshotConfig,
} from "./config-state-model.ts";
import {
  createConfigWriteReconciliation,
  type ConfigWriteFlight,
} from "./config-write-reconciliation.ts";

/** Debounce window between the last form edit and its automatic config.set. */
const CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS = 800;

export function createConfigWriteCoordinator({
  state,
  gateway,
  publish,
  run,
  mutate,
  resetLoads,
  resetConfigLoad,
  refreshConnectionState,
  canCallConfigMethod,
  appliedRefresh,
  isDisposed,
}: ConfigWriteCoordinatorContext): ConfigWriteCoordinator {
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: ConfigWriteFlight | null = null;
  let autoSaveTrailing = false;
  let autoSaveDraftConnection: { client: GatewayBrowserClient; epoch: number } | null = null;
  let autoSaveRequiresExplicitSubmit = false;
  // Discard drains writes without resaving the draft it is about to remove.
  let suppressAutoSave = 0;
  // Disconnect must release drains even when the orphaned transport never settles.
  let connectionWake = createDeferredCore();
  // Config writes and restarts must wait for the app updater to settle.
  let writesSuspended = false;
  let refreshWriteAdmission: (() => Promise<void>) | undefined;
  let writesResumed: Deferred | null = null;
  const canDispatchConfigMutation = (method: ConfigMethod): boolean => {
    const allowed = canCallConfigMethod(method);
    if (!allowed && state.connected) {
      state.lastError = t("configView.adminRequired");
      if (state.configAutoSaveStatus === "rejected") {
        state.configAutoSaveStatus = "error";
      }
      publish();
    }
    if (allowed && method !== "config.patch" && !reconciliation.canWriteDraft()) {
      publish();
      return false;
    }
    return allowed;
  };
  const clearAutoSaveDraftConnection = () => {
    autoSaveDraftConnection = null;
    autoSaveRequiresExplicitSubmit = false;
    if (state.configAutoSaveStatus === "paused") {
      state.configAutoSaveStatus = "idle";
    }
  };
  const pauseAutoSaveDraftConnection = () => {
    autoSaveRequiresExplicitSubmit = true;
    // Conflict outranks the reconnect latch: the snapshot is still stale.
    if (state.configFormMode === "form" && state.configAutoSaveStatus !== "conflict") {
      state.configAutoSaveStatus = "paused";
    }
  };
  const captureAutoSaveDraftConnection = () => {
    if (autoSaveRequiresExplicitSubmit) {
      pauseAutoSaveDraftConnection();
      return;
    }
    if (
      autoSaveDraftConnection ||
      !state.client ||
      !state.connected ||
      !state.configFormDirty ||
      state.configFormMode !== "form"
    ) {
      return;
    }
    autoSaveDraftConnection = {
      client: state.client,
      epoch: currentConfigConnectionEpoch(state),
    };
  };
  const bindDraftToExplicitSubmit = () => {
    if (!state.client || !state.connected || state.configFormMode !== "form") {
      return;
    }
    autoSaveDraftConnection = {
      client: state.client,
      epoch: currentConfigConnectionEpoch(state),
    };
    autoSaveRequiresExplicitSubmit = false;
    if (state.configAutoSaveStatus === "paused") {
      state.configAutoSaveStatus = "idle";
    }
  };
  // Stale bases and previous connections require explicit recovery, including teardown.
  const canAutoSaveDraft = () =>
    state.configAutoSaveStatus !== "conflict" &&
    state.configRecoveryError === null &&
    reconciliation.canWriteDraft() &&
    !autoSaveRequiresExplicitSubmit &&
    autoSaveDraftConnection !== null &&
    autoSaveDraftConnection.client === state.client &&
    autoSaveDraftConnection.epoch === currentConfigConnectionEpoch(state);
  const reconciliation = createConfigWriteReconciliation({
    state,
    getFlight: () => inFlight,
    invalidateConfigLoad: () => invalidateConfigLoad(),
    refreshConnectionState,
    refreshSnapshot: () =>
      run(() => loadConfig(state, { background: true, draftWrites: writes }), "config"),
    isDisposed,
    pauseAutoSaveDraftConnection,
    clearAutoSaveDraftConnection,
    publish,
    reconcileAppliedRefresh: appliedRefresh.reconcile,
  });
  const { applySnapshot, unacknowledgedDraftWrite, hasUnacknowledgedDraftWrite } = reconciliation;
  const reconcileAutoSaveDraftConnection = () => {
    if (state.configFormDirty) {
      captureAutoSaveDraftConnection();
    } else if (inFlight === null) {
      clearAutoSaveDraftConnection();
    }
  };
  const cancelScheduledAutoSave = () => {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    autoSaveTrailing = false;
  };
  const invalidateConfigLoad = () => {
    resetConfigLoad();
    nextRequestVersion(state, "config");
    state.configLoading = false;
  };
  const trackWrite = <T>(
    task: (onSubmitted: ConfigSubmissionObserver) => Promise<T>,
    auto = false,
  ): Promise<T> => {
    const { flight, onSubmitted } = reconciliation.createFlight();
    const submit = task(onSubmitted);
    flight.promise = submit
      .catch(() => false)
      .then((saved) => {
        // A disconnected flight cannot retire its successor or trail-save over it.
        if (inFlight !== flight) {
          return;
        }
        const uncertainDraftWrite = !saved && hasUnacknowledgedDraftWrite();
        if (uncertainDraftWrite) {
          cancelScheduledAutoSave();
        }
        inFlight = null;
        reconciliation.reconcileSettledFlight(
          flight,
          uncertainDraftWrite,
          auto ? reconcileAutoSaveDraftConnection : undefined,
        );
        const wantsTrailing =
          autoSaveTrailing ||
          (auto &&
            saved &&
            state.configFormDirty &&
            state.configFormMode === "form" &&
            autoSaveTimer === null);
        autoSaveTrailing = false;
        if (wantsTrailing && !isDisposed()) {
          runAutoSave();
        } else {
          appliedRefresh.reconcile();
        }
      });
    inFlight = flight;
    return submit;
  };
  const runAutoSave = () => {
    if (
      isDisposed() ||
      suppressAutoSave ||
      writesSuspended ||
      !canAutoSaveDraft() ||
      !canCallConfigMethod("config.set")
    ) {
      return;
    }
    if (inFlight) {
      // Edits during any write fold into one trailing autosave on its new base.
      autoSaveTrailing = true;
      return;
    }
    appliedRefresh.cancel();
    void trackWrite(
      (onSubmitted) =>
        run(() =>
          submitConfigDraft(state, "auto", onSubmitted, () => {
            if (!canDispatchConfigMutation("config.set")) {
              return false;
            }
            patches.clear();
            return true;
          }),
        ),
      true,
    ).catch(() => undefined);
  };
  const flushScheduledAutoSave = () => {
    if (!autoSaveTimer) {
      return;
    }
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
    runAutoSave();
  };
  const scheduleAutoSave = () => {
    // Raw JSON5 drafts stay manual; suspended form edits resume after the updater.
    if (
      isDisposed() ||
      writesSuspended ||
      !canAutoSaveDraft() ||
      !canCallConfigMethod("config.set") ||
      !state.configFormDirty ||
      state.configFormMode !== "form"
    ) {
      return;
    }
    appliedRefresh.cancel();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      runAutoSave();
    }, CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  };
  // Drain manual writes and the whole autosave chain before reusing the base hash.
  const drainPendingWrites = async (flushScheduledDraft = false): Promise<void> => {
    while (true) {
      if (flushScheduledDraft) {
        // External writers must also wait for edits still in the debounce window.
        flushScheduledAutoSave();
      }
      const flight = inFlight;
      if (!flight) {
        return;
      }
      // Deregistration releases the drain independently of transport rejection order.
      await Promise.race([flight.promise, connectionWake.promise]);
      if (isDisposed()) {
        return;
      }
      if (!flushScheduledDraft) {
        // Save/apply include newer edits; cancel their debounce before reusing the hash.
        cancelScheduledAutoSave();
      }
    }
  };
  const holdAutoSave = () => {
    suppressAutoSave++;
    cancelScheduledAutoSave();
    return (resume: boolean) => {
      suppressAutoSave--;
      if (resume) {
        scheduleAutoSave();
      }
    };
  };
  // Explicit writes also serialize with each other, not just the autosave chain.
  let explicitOpQueue: Promise<unknown> | null = null;
  const afterPendingWritesSettled = <T>(
    task: (onSubmitted: ConfigSubmissionObserver) => Promise<T>,
    unavailable: (recoveryError?: string) => T,
    options: { flushScheduledDraft?: boolean; canDispatch?: () => boolean } = {},
  ): Promise<T> => {
    if (writesSuspended && !refreshWriteAdmission) {
      return Promise.resolve(unavailable());
    }
    const client = state.client;
    const connectionEpoch = currentConfigConnectionEpoch(state);
    if (options.flushScheduledDraft) {
      flushScheduledAutoSave();
    } else {
      cancelScheduledAutoSave();
    }
    // With no queued write, dispatch synchronously against the captured connection.
    const start = () =>
      run(async () => {
        if (writesSuspended && refreshWriteAdmission && !isDisposed()) {
          // The Gateway classifies driver liveness and retained recovery before this interlock can open.
          await refreshWriteAdmission();
          if (!writesSuspended) {
            if (options.flushScheduledDraft) {
              flushScheduledAutoSave();
            } else {
              cancelScheduledAutoSave();
            }
          }
        }
        if (inFlight) {
          await drainPendingWrites(options.flushScheduledDraft);
        }
        const reconnectRead =
          reconciliation.interrupted && options.flushScheduledDraft
            ? currentConfigRead(state)
            : null;
        if (reconnectRead) {
          await Promise.race([reconnectRead.completion.promise, reconnectRead.invalidated.promise]);
        }
        // The updater can claim suspension while the preceding write drains.
        const connected = client && isCurrentConfigConnection(state, client, connectionEpoch);
        if (writesSuspended || isDisposed() || !connected) {
          return unavailable();
        }
        // Method/scope metadata can change without replacing the connection epoch.
        if (state.configRecoveryError !== null || options.canDispatch?.() === false) {
          return unavailable(state.configRecoveryError ?? undefined);
        }
        if (options.flushScheduledDraft && hasUnacknowledgedDraftWrite()) {
          state.lastError = t("configView.writeUnconfirmed");
          state.configAutoSaveStatus = "error";
          return unavailable(state.lastError);
        }
        return await trackWrite(task);
      });
    const queued = explicitOpQueue ? explicitOpQueue.then(start) : start();
    const tail: Promise<unknown> = queued
      .catch(() => false)
      .then(() => {
        if (explicitOpQueue === tail) {
          explicitOpQueue = null;
        }
      });
    explicitOpQueue = tail;
    return queued;
  };
  const fieldDiscard = createConfigFieldDiscard({
    state,
    serialize: (task) => afterPendingWritesSettled(task, () => false),
    readSnapshot: () => run(() => loadConfig(state, { draftWrites: writes }), "config"),
    hasUnacknowledgedDraftWrite,
    holdAutoSave,
    isDisposed,
    publish,
    reconcileDraft: reconcileAutoSaveDraftConnection,
  });
  const stopGateway = gateway.subscribe((snapshot) => {
    const clientChanged = state.client !== snapshot.client;
    const connectionChanged = state.connected !== (snapshot.phase === "connected");
    state.client = snapshot.client;
    state.connected = snapshot.phase === "connected";
    state.applySessionKey = snapshot.sessionKey;
    if (clientChanged || connectionChanged) {
      const unacknowledged = unacknowledgedDraftWrite();
      fieldDiscard.invalidate();
      reconciliation.retireConnection();
      patches.clear();
      const draftBelongsToPreviousConnection =
        state.configFormDirty || inFlight !== null || unacknowledged !== null;
      resetLoads();
      // A retired flight cannot hold the replacement connection's FIFO.
      explicitOpQueue = null;
      // Reconnect can reuse the client object; the epoch must still advance.
      invalidateConfigConnection(state);
      cancelScheduledAutoSave();
      appliedRefresh.cancel();
      if (draftBelongsToPreviousConnection) {
        // Retain the draft, visibly paused until Save/Apply or reload binds it
        // to the new connection; silent suspension would make later edits look saved.
        pauseAutoSaveDraftConnection();
      }
      if (inFlight !== null || unacknowledged !== null) {
        // Retain uncertain receipts while releasing drains before transport settlement.
        reconciliation.interrupt(inFlight?.submission ?? unacknowledged);
        inFlight = null;
        autoSaveTrailing = false;
      }
      // Re-arm first so resumed drains wait on a pending signal on their next iteration.
      const wake = connectionWake;
      connectionWake = createDeferredCore();
      wake.resolve();
      state.configLoading = false;
      state.configSchemaLoading = false;
      state.configSaving = false;
      state.configApplying = false;
      if (state.configAutoSaveStatus === "saving") {
        state.configAutoSaveStatus = "idle";
      }
      if (state.connected && state.client) {
        if (reconciliation.interrupted) {
          reconciliation.refreshInterrupted();
        } else {
          void refreshDraft(state, refreshConnectionState, publish, appliedRefresh.reconcile);
        }
      }
    }
    publish();
  });

  const patches = createConfigPatchCoordinator({
    state,
    reconcileDraft: reconcileAutoSaveDraftConnection,
    dispatch: (task) =>
      afterPendingWritesSettled(task, () => false, {
        flushScheduledDraft: true,
        canDispatch: () => canDispatchConfigMutation("config.patch"),
      }),
    appliedRefresh,
    scheduleAutoSave: () => {
      if (!hasUnacknowledgedDraftWrite()) {
        scheduleAutoSave();
      }
    },
  });
  const mutateDraft = (mutation: () => void, path?: Array<string | number>) => {
    fieldDiscard.invalidate(path);
    mutate(mutation);
    reconcileAutoSaveDraftConnection();
    scheduleAutoSave();
  };
  const submitExplicitDraft = (mode: "save" | "apply", canDispatch: () => boolean) =>
    !canDispatch()
      ? Promise.resolve(false)
      : afterPendingWritesSettled(
          async (onSubmitted) => {
            bindDraftToExplicitSubmit();
            appliedRefresh.cancel();
            try {
              // A drained raw Save may apply; a still-dirty raw draft remains manual-save-only.
              if (mode === "apply" && state.configFormDirty && state.configFormMode === "raw") {
                state.configAutoSaveStatus = "error";
                state.lastError = t("configView.rawDraftBlocksApply");
                return false;
              }
              const saved = await submitConfigDraft(
                state,
                mode,
                (submission) => {
                  if (mode === "save" && submission.ack === null) {
                    patches.clear();
                  }
                  onSubmitted(submission);
                },
                () => {
                  if (!canDispatch()) {
                    return false;
                  }
                  if (mode === "apply") {
                    patches.clear();
                  }
                  return true;
                },
              );
              reconcileAutoSaveDraftConnection();
              return saved;
            } finally {
              appliedRefresh.reconcile();
            }
          },
          () => false,
          { canDispatch },
        );
  const writes: ConfigWriteCoordinator = {
    hasUnacknowledgedDraftWrite,
    applySnapshot,
    patchForm: (path, value) => mutateDraft(() => updateConfigFormValue(state, path, value), path),
    removeFormValue: (path) => mutateDraft(() => removeConfigFormValue(state, path), path),
    setRaw: (value) =>
      mutateDraft(() => updateConfigRawValue(state, value, hasUnacknowledgedDraftWrite())),
    discardFormValue: fieldDiscard.discard,
    discardDraft: createConfigDraftDiscard({
      state,
      invalidateFieldDiscards: fieldDiscard.invalidate,
      hasInFlightWrite: () => inFlight !== null,
      holdAutoSave,
      drainPendingWrites,
      clearPatches: patches.clear,
      run,
      mutate,
      clearDraftConnection: () => {
        reconciliation.clear();
        clearAutoSaveDraftConnection();
      },
      appliedRefresh,
    }),
    setWritesSuspended: (suspended, refreshAdmission) => {
      refreshWriteAdmission = refreshAdmission;
      if (writesSuspended === suspended) {
        return;
      }
      writesSuspended = suspended;
      if (suspended) {
        cancelScheduledAutoSave();
        writesResumed = createDeferredCore();
      } else {
        const resume = writesResumed;
        writesResumed = null;
        resume?.resolve();
        // Resume pending edits, but an uncertain write still needs explicit recovery.
        if (!hasUnacknowledgedDraftWrite()) {
          scheduleAutoSave();
        }
      }
    },
    waitForPendingWrites: () => drainPendingWrites(true),
    flushFormChanges: async () => {
      const client = state.client;
      const epoch = currentConfigConnectionEpoch(state);
      if (!client || !canCallConfigMethod("config.set") || state.configFormMode !== "form") {
        return false;
      }
      // Field commits skip the debounce, but never rebind a retained draft as
      // manual Save does. A new revision alone cannot acknowledge this draft.
      await drainPendingWrites(true);
      return (
        !isDisposed() &&
        isCurrentConfigConnection(state, client, epoch) &&
        !state.configFormDirty &&
        state.configRecoveryError === null &&
        (state.configAutoSaveStatus === "saved" || state.configAutoSaveStatus === "idle")
      );
    },
    save: (options = {}) =>
      submitExplicitDraft(
        "save",
        () => canDispatchConfigMutation("config.set") && (options.canDispatch?.() ?? true),
      ),
    retry: () =>
      patches.retry(() =>
        reconciliation.latestSubmission?.operation === "apply" ? writes.apply() : writes.save(),
      ),
    apply: () => submitExplicitDraft("apply", () => canDispatchConfigMutation("config.apply")),
    stageDefaultAgent: (agentId) => {
      if (!canDispatchConfigMutation("config.set")) {
        return false;
      }
      fieldDiscard.invalidate(["agents"]);
      const changed = stageDefaultAgentConfigEntry(state, agentId);
      publish();
      reconcileAutoSaveDraftConnection();
      scheduleAutoSave();
      return changed;
    },
    // Patches share suspension/drain ownership but do not submit the form draft;
    // flush its debounce before patching and re-arm it afterward if still dirty.
    patch: (options) =>
      canDispatchConfigMutation("config.patch") && (options.canDispatch?.() ?? true)
        ? patches.queue(() => ({ options }))
        : Promise.resolve(false),
    patchFromSnapshot: (build) =>
      canDispatchConfigMutation("config.patch")
        ? patches.queue(() => {
            const config = resolveEditableSnapshotConfig(state.configSnapshot);
            return config
              ? build(config)
              : { error: "Configuration is unavailable; refresh and try again." };
          })
        : Promise.resolve(false),
    runExternalMutation: async <T>(
      task: (client: GatewayBrowserClient) => Promise<T>,
      options: RuntimeConfigExternalMutationOptions<T> = {},
    ): Promise<RuntimeConfigExternalMutationResult<T>> => {
      const mutationClient = state.client;
      const mutationConnectionEpoch = currentConfigConnectionEpoch(state);
      while (true) {
        if (options.waitForWritesResumed && writesSuspended && !isDisposed()) {
          await refreshWriteAdmission?.();
          if (writesSuspended && !isDisposed()) {
            await writesResumed?.promise;
          }
        }
        if (
          !mutationClient ||
          !isCurrentConfigConnection(state, mutationClient, mutationConnectionEpoch)
        ) {
          return {
            ok: false,
            reason: "unavailable",
            error: "Connection changed before the configuration update started.",
          };
        }
        const result = await afterPendingWritesSettled<RuntimeConfigExternalMutationResult<T>>(
          (onSubmitted) =>
            executeConfigExternalMutation(
              state,
              mutationClient,
              mutationConnectionEpoch,
              task,
              options,
              () => run(() => refreshConfigAfterMutation(state, { draftWrites: writes }), "config"),
              onSubmitted,
            ),
          (recoveryError) => ({
            ok: false,
            reason: writesSuspended ? "suspended" : "unavailable",
            error:
              recoveryError ??
              (writesSuspended
                ? "Configuration writes are temporarily suspended."
                : "Configuration is unavailable; reconnect and try again."),
          }),
          { flushScheduledDraft: true },
        );
        if (
          !(
            options.waitForWritesResumed &&
            !isDisposed() &&
            !result.ok &&
            (result.reason === "suspended" || writesSuspended)
          )
        ) {
          return result;
        }
      }
    },
    dispose() {
      fieldDiscard.invalidate();
      patches.clear();
      writesResumed?.resolve();
      writesResumed = null;
      // Release pending drains; their disposed guard exits the loop.
      connectionWake.resolve();
      // Flush once on teardown, chaining behind any flight for its receipt.
      // Epoch invalidation retires callbacks, not the flush's captured admission checks.
      const client = state.client;
      const canFlush =
        state.connected && client !== null && !writesSuspended && canCallConfigMethod("config.set");
      const pendingFlight = inFlight;
      cancelScheduledAutoSave();
      appliedRefresh.dispose();
      if (client && pendingFlight) {
        reconciliation.flushDisposedFlight(
          client,
          pendingFlight,
          () => canFlush && !autoSaveRequiresExplicitSubmit && canCallConfigMethod("config.set"),
        );
      } else if (
        canFlush &&
        !hasUnacknowledgedDraftWrite() &&
        canAutoSaveDraft() &&
        state.configFormDirty &&
        state.configFormMode === "form"
      ) {
        void submitConfigDraft(state, "auto", undefined, () => canCallConfigMethod("config.set"));
      }
      invalidateConfigConnection(state);
      state.connected = false;
      state.configLoading = false;
      state.configSchemaLoading = false;
      state.configSaving = false;
      state.configApplying = false;
      stopGateway();
      reconciliation.clear();
    },
  };
  return writes;
}
