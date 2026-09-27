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
  cancelAppliedRefresh,
  reconcileAppliedRefresh,
  disposeAppliedRefresh,
  isDisposed,
}: ConfigWriteCoordinatorContext): ConfigWriteCoordinator {
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: ConfigWriteFlight | null = null;
  let autoSaveTrailing = false;
  let autoSaveDraftConnection: { client: GatewayBrowserClient; epoch: number } | null = null;
  let autoSaveRequiresExplicitSubmit = false;
  // Blocks trailing autosaves while a discard drains pending writes; the
  // drained draft is about to be thrown away, not re-written.
  let suppressAutoSave = 0;
  // Wakes drains awaiting a request a connection change just orphaned — that
  // request may never settle, and a drain stuck on it would wedge the app
  // updater barrier, applies, and discards until then.
  let connectionWake: (() => void) | null = null;
  let connectionWakePromise: Promise<void> = Promise.resolve();
  const armConnectionWake = () => {
    connectionWakePromise = new Promise((resolve) => {
      connectionWake = resolve;
    });
  };
  armConnectionWake();
  // App-updater interlock: config writes or gateway restarts mid-update can
  // corrupt the install, so all writes pause until the updater settles.
  let writesSuspended = false;
  let refreshWriteAdmission: (() => Promise<void>) | undefined;
  let writesResumed: (() => void) | null = null;
  let writesResumedPromise: Promise<void> = Promise.resolve();
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
    reconcileAppliedRefresh,
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
        // Disconnect deregisters the flight; its late completion must not steal
        // the replacement connection's registration or trailing save.
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
          reconcileAppliedRefresh();
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
    cancelAppliedRefresh();
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
    // Only form-draft edits auto-save; raw-text drafts stay manual so a
    // half-typed JSON5 buffer never gets written to disk. Suspended writes
    // (app updater running) stay dirty and reschedule when suspension lifts.
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
    cancelAppliedRefresh();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
    }
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      runAutoSave();
    }, CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  };
  // Manual save/apply serialize the current draft themselves; cancel any
  // dangling debounce and settle an in-flight autosave first so the explicit
  // write does not race it on the baseHash guard. The submit starts
  // synchronously when nothing is in flight so it binds to the current
  // connection epoch.
  // Drains ALL pending config writes: the autosave chain (a settling flight
  // can spawn a trailing save) AND any manual Save still in flight.
  const drainPendingWrites = async (flushScheduledDraft = false): Promise<void> => {
    while (true) {
      if (flushScheduledDraft) {
        // A debounce timer is pending persisted intent. Flush it into a tracked
        // flight before draining so external writers cannot race the draft.
        flushScheduledAutoSave();
      }
      const flight = inFlight;
      if (!flight) {
        return;
      }
      // Race the connection wake: a disconnect deregisters in-flight writes,
      // and a drain already awaiting one resumes from that deregistration
      // instead of depending on the transport's close-time rejection order.
      await Promise.race([flight.promise, connectionWakePromise]);
      if (isDisposed()) {
        return;
      }
      if (!flushScheduledDraft) {
        // save/apply submit the latest full draft themselves. Edits made
        // while the preceding flight settled may have armed a fresh debounce;
        // cancel it before the explicit write starts or it can race the same
        // post-flight base hash.
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
  // Explicit ops (save/apply/patch) also serialize among THEMSELVES: two
  // callers queued behind the same in-flight write would otherwise both
  // finish draining and dispatch against the same base hash.
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
    // Start synchronously when no explicit op is queued so the submit binds
    // to the CURRENT connection epoch; only genuine queuing pays the hop.
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
        // Drain before the explicit op — otherwise an apply could race a
        // pending config.set on the same base hash into a CAS failure.
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
        // The updater may have started while we drained; suspension must be a
        // real barrier or an apply could restart the gateway mid-update.
        const connected = client && isCurrentConfigConnection(state, client, connectionEpoch);
        if (writesSuspended || isDisposed() || !connected) {
          return unavailable();
        }
        // Hello method/scope metadata can change while the client and
        // connection epoch stay stable. Recheck at the dispatch boundary.
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
      // A dead prior-connection flight must not keep the reconnected owner's
      // explicit-operation FIFO waiting forever.
      explicitOpQueue = null;
      // A reconnect may reuse the client object. Keep generations monotonic so work
      // from the previous connection cannot commit into the new connection epoch.
      invalidateConfigConnection(state);
      cancelScheduledAutoSave();
      cancelAppliedRefresh();
      if (draftBelongsToPreviousConnection) {
        // A retained draft belongs to the Gateway connection where the edit
        // began. Preserve it across replacement, but require an explicit
        // Save/Apply or reload before the new Gateway may receive it. The
        // latch must be visible: without a rendered state the form looks
        // normal while every subsequent edit silently never saves.
        pauseAutoSaveDraftConnection();
      }
      if (inFlight !== null || unacknowledged !== null) {
        // The epoch guard already blocks these flights from mutating state;
        // deregistering releases drain barriers and the trailing-save chain
        // promptly instead of waiting on the transport's close-time
        // rejection (protocol-client flushRequests rejects all pending
        // requests on socket close, so nothing here can hang forever).
        // Remember the uncertain submission for reconnect reconciliation.
        reconciliation.interrupt(inFlight?.submission ?? unacknowledged);
        inFlight = null;
        autoSaveTrailing = false;
      }
      // Re-arm before waking so a resumed drain that loops again races the
      // fresh (still-pending) signal, not the one just resolved.
      const wake = connectionWake;
      armConnectionWake();
      wake?.();
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
          void refreshDraft(state, refreshConnectionState, publish, reconcileAppliedRefresh);
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
    cancelAppliedRefresh,
    reconcileAppliedRefresh,
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
      cancelAppliedRefresh,
      reconcileAppliedRefresh,
    }),
    setWritesSuspended: (suspended, refreshAdmission) => {
      refreshWriteAdmission = refreshAdmission;
      if (writesSuspended === suspended) {
        return;
      }
      writesSuspended = suspended;
      if (suspended) {
        cancelScheduledAutoSave();
        writesResumedPromise = new Promise((resolve) => {
          writesResumed = resolve;
        });
      } else {
        const resume = writesResumed;
        writesResumed = null;
        resume?.();
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
    save: (options = {}) => {
      const canDispatch = () =>
        canDispatchConfigMutation("config.set") && (options.canDispatch?.() ?? true);
      return !canDispatch()
        ? Promise.resolve(false)
        : afterPendingWritesSettled(
            async (onSubmitted) => {
              bindDraftToExplicitSubmit();
              cancelAppliedRefresh();
              try {
                const saved = await submitConfigDraft(
                  state,
                  "save",
                  (submission) => {
                    if (submission.ack === null) {
                      patches.clear();
                    }
                    onSubmitted(submission);
                  },
                  canDispatch,
                );
                reconcileAutoSaveDraftConnection();
                return saved;
              } finally {
                reconcileAppliedRefresh();
              }
            },
            () => false,
            { canDispatch },
          );
    },
    retry: () =>
      patches.retry(() =>
        reconciliation.latestSubmission?.operation === "apply" ? writes.apply() : writes.save(),
      ),
    apply: () =>
      !canDispatchConfigMutation("config.apply")
        ? Promise.resolve(false)
        : afterPendingWritesSettled(
            async (onSubmitted) => {
              bindDraftToExplicitSubmit();
              cancelAppliedRefresh();
              // Checked after the drain: a raw draft whose explicit Save is in
              // flight resolves clean and may apply. A raw draft that is STILL
              // dirty here was never reviewed-saved — applying would implicitly
              // write unreviewed raw text, so refuse and point at the Raw editor.
              if (state.configFormDirty && state.configFormMode === "raw") {
                state.configAutoSaveStatus = "error";
                state.lastError = t("configView.rawDraftBlocksApply");
                reconcileAppliedRefresh();
                return false;
              }
              try {
                const applied = await submitConfigDraft(state, "apply", onSubmitted, () => {
                  if (!canDispatchConfigMutation("config.apply")) {
                    return false;
                  }
                  patches.clear();
                  return true;
                });
                reconcileAutoSaveDraftConnection();
                return applied;
              } finally {
                reconcileAppliedRefresh();
              }
            },
            () => false,
            { canDispatch: () => canDispatchConfigMutation("config.apply") },
          ),
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
    // Patches are config writes too: they must honor updater suspension and
    // register as a drainable flight, or a patch could overlap update.run.
    // Unlike save/apply, a patch does not submit the form draft — flush a
    // scheduled autosave into a flight first (the settle below drains it) and
    // re-arm the debounce after so a dirty form is never left timer-less.
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
            await writesResumedPromise;
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
      writesResumed?.();
      writesResumed = null;
      // Free any drain awaiting a flight that will never be reconciled now;
      // the isDisposed() guard exits its loop.
      connectionWake?.();
      // SPA teardown right after an edit must not silently drop it: fire one
      // last save before timers die, or chain once behind an in-flight save.
      // Invalidation retires live callbacks; the retained receipt below still
      // updates the draft, while dispatch keeps its captured admission checks.
      const client = state.client;
      const canFlush =
        state.connected && client !== null && !writesSuspended && canCallConfigMethod("config.set");
      const pendingFlight = inFlight;
      cancelScheduledAutoSave();
      disposeAppliedRefresh();
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
