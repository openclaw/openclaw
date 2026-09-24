import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ConfigSnapshot } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { cloneConfigObject } from "../config-form-utils.ts";
import {
  adoptConfigWriteAck,
  applyConfigSnapshot,
  comparableSnapshotRaw,
  rebaseConfigDraft,
  resetConfigPendingChanges,
  serializeFormForSubmit,
} from "./config-draft-model.ts";
import { teardownFlushConfigDraft, type ConfigSubmission } from "./config-gateway-operations.ts";
import {
  currentConfigConnectionEpoch,
  isCurrentConfigConnection,
  resolveEditableSnapshotConfig,
  type LoadConfigOptions,
  type RuntimeConfigState,
} from "./config-state-model.ts";

type ConfigWriteReceipt = ConfigSubmission & { gatewayUrl: string };

export type ConfigWriteFlight = {
  promise: Promise<unknown>;
  submission: ConfigWriteReceipt | null;
  snapshotAtDispatch: ConfigSnapshot | null;
};

export function createConfigWriteReconciliation({
  state,
  getFlight,
  invalidateConfigLoad,
  refreshConnectionState,
  refreshSnapshot,
  isDisposed,
  pauseAutoSaveDraftConnection,
  clearAutoSaveDraftConnection,
  publish,
  reconcileAppliedRefresh,
}: {
  state: RuntimeConfigState;
  getFlight: () => ConfigWriteFlight | null;
  invalidateConfigLoad: () => void;
  refreshConnectionState: (
    beforeApplySnapshot: () => void,
    preservePendingChanges: boolean,
  ) => Promise<boolean>;
  refreshSnapshot: () => Promise<unknown>;
  isDisposed: () => boolean;
  pauseAutoSaveDraftConnection: () => void;
  clearAutoSaveDraftConnection: () => void;
  publish: () => void;
  reconcileAppliedRefresh: () => void;
}) {
  let lastSubmission: ConfigWriteReceipt | null = null;
  let hasInterruptedWrite = false;
  let interruptedSubmission: ConfigWriteReceipt | null = null;
  const clearInterruptedWrite = () => {
    hasInterruptedWrite = false;
    interruptedSubmission = null;
  };
  const unacknowledgedDraftWrite = () => {
    const submission = lastSubmission ?? interruptedSubmission;
    return submission &&
      !submission.ack &&
      !submission.rejected &&
      submission.operation !== "independent"
      ? submission
      : null;
  };
  const hasUnacknowledgedDraftWrite = () => unacknowledgedDraftWrite() !== null;
  const matchesGateway = (submission: ConfigWriteReceipt, client: GatewayBrowserClient | null) =>
    client !== null &&
    (submission.gatewayUrl === client.gatewayUrl ||
      gatewayCredentialScope(submission.gatewayUrl) === gatewayCredentialScope(client.gatewayUrl));
  const canWriteDraft = () => {
    const submitted = unacknowledgedDraftWrite();
    if (!submitted || matchesGateway(submitted, state.client)) {
      return true;
    }
    if (!state.client) {
      return false;
    }
    state.configAutoSaveStatus = "error";
    state.lastError = t("configView.writeGatewayChanged");
    return false;
  };
  const applySnapshot = (snapshot: ConfigSnapshot, options: LoadConfigOptions = {}) => {
    const submitted = unacknowledgedDraftWrite();
    applyConfigSnapshot(state, snapshot, {
      ...options,
      preservePendingChanges: submitted !== null || options.preservePendingChanges === true,
    });
    if (options.discardPendingChanges) {
      lastSubmission = null;
      clearInterruptedWrite();
      return;
    }
    const config = resolveEditableSnapshotConfig(snapshot);
    const revision = snapshot.configRevisionHash ?? snapshot.hash;
    // Without raw bytes, editable content only confirms an unchanged Form save.
    const snapshotRaw =
      submitted?.form && submitted.raw === state.configRawOriginal
        ? comparableSnapshotRaw(snapshot)
        : snapshot.raw;
    if (
      submitted &&
      matchesGateway(submitted, state.client) &&
      getFlight()?.submission !== submitted &&
      snapshotRaw === submitted.raw &&
      snapshot.hash &&
      config
    ) {
      // Persisted content advances the retry base; Apply also needs runtime confirmation.
      const ack = { config, hash: snapshot.hash };
      const confirmed =
        submitted.operation === "save" ||
        (Boolean(revision) && snapshot.appliedConfigHash === revision);
      const failureStatus = state.configAutoSaveStatus;
      const failureMessage = state.lastError;
      adoptConfigWriteAck(state, submitted, ack, { raw: snapshot.raw });
      if (confirmed) {
        lastSubmission = { ...submitted, ack };
        clearInterruptedWrite();
      }
      if ((!confirmed || state.configFormDirty) && state.configAutoSaveStatus !== "conflict") {
        state.configAutoSaveStatus = failureStatus === "conflict" ? "error" : failureStatus;
        state.lastError = failureMessage;
      } else if (confirmed && !state.configFormDirty) {
        state.lastError = null;
      }
    }
  };

  return {
    applySnapshot,
    canWriteDraft,
    unacknowledgedDraftWrite,
    hasUnacknowledgedDraftWrite,
    get latestSubmission() {
      return lastSubmission ?? interruptedSubmission;
    },
    get interrupted() {
      return hasInterruptedWrite;
    },
    createFlight() {
      const previousSubmission = unacknowledgedDraftWrite();
      const flight: ConfigWriteFlight = {
        promise: Promise.resolve(),
        submission: null,
        snapshotAtDispatch: state.configSnapshot,
      };
      const client = state.client;
      const epoch = currentConfigConnectionEpoch(state);
      const onSubmitted = (submission: ConfigSubmission) => {
        if (!client) {
          return;
        }
        const receipt = { ...submission, gatewayUrl: client.gatewayUrl };
        if (!submission.ack && !submission.rejected) {
          flight.snapshotAtDispatch = state.configSnapshot;
        }
        flight.submission = receipt;
        // Old-connection completions retain their flight receipt only for teardown.
        if (client && !isDisposed() && isCurrentConfigConnection(state, client, epoch)) {
          lastSubmission = submission.rejected && previousSubmission ? previousSubmission : receipt;
          if (submission.ack) {
            clearInterruptedWrite();
          }
        }
        // Keep the ack for teardown, but only a live flight may retire older loads.
        if (submission.ack && !isDisposed() && getFlight() === flight) {
          invalidateConfigLoad();
        }
      };
      return { flight, onSubmitted };
    },
    reconcileSettledFlight(
      flight: ConfigWriteFlight,
      uncertain: boolean,
      reconcileDraft?: () => void,
    ) {
      if (uncertain && state.configSnapshot && state.configSnapshot !== flight.snapshotAtDispatch) {
        applySnapshot(state.configSnapshot);
      }
      // Explicit operations own recovery status; a failed patch keeps its Retry action.
      reconcileDraft?.();
      if (
        flight.submission?.rejected &&
        !hasUnacknowledgedDraftWrite() &&
        !state.configFormDirty &&
        state.configSnapshot
      ) {
        applyConfigSnapshot(state, state.configSnapshot);
      } else if (flight.submission?.rejected && hasUnacknowledgedDraftWrite()) {
        // The rejected successor may have raced our own earlier commit. Read once; retry stays explicit.
        void refreshSnapshot();
      }
    },
    flushDisposedFlight(
      client: GatewayBrowserClient,
      flight: ConfigWriteFlight,
      canDispatch: () => boolean,
    ) {
      void flight.promise.then(() => {
        // Adopt the acknowledged pair even when admission prevents a final write.
        const submitted = flight.submission;
        const ack = submitted?.ack ?? null;
        if (ack && submitted && matchesGateway(submitted, client)) {
          teardownFlushConfigDraft(state, client, submitted, ack, canDispatch);
        }
      });
    },
    retireConnection() {
      lastSubmission = null;
    },
    interrupt(submitted: ConfigWriteReceipt | null) {
      hasInterruptedWrite = true;
      interruptedSubmission = submitted?.ack ? null : submitted;
    },
    refreshInterrupted() {
      // The interrupted write may or may not have committed. Fetch the
      // authoritative snapshot so an uncertain flight cannot leave a
      // clean-looking draft or a stale base. Replacement connections
      // never resume autosave for the retained draft.
      const interrupted = interruptedSubmission;
      const interruptedRaw = interrupted?.raw ?? null;
      if (interrupted && !interrupted.ack && !interrupted.rejected) {
        lastSubmission = interrupted;
      }
      // A revert made while the write was in flight reads clean (the ack
      // never rebased the originals), so the reload below would replace
      // it with the committed bytes. Capture it for restoration.
      const captureDraft = () => ({
        form: cloneConfigObject(state.configForm ?? {}),
        raw: state.configRaw,
        mode: state.configFormMode,
        originalRaw: state.configRawOriginal,
        dirty: state.configFormDirty,
        submittedRaw: state.configFormDirty ? serializeFormForSubmit(state) : state.configRaw,
      });
      let draftBefore: ReturnType<typeof captureDraft> | null = null;
      void refreshConnectionState(() => {
        draftBefore = captureDraft();
      }, interruptedRaw !== null).then((loaded) => {
        if (isDisposed()) {
          return;
        }
        if (!loaded || !state.connected) {
          // Reload failed or the connection flipped again: keep the
          // interruption metadata so the NEXT reconnect retries
          // reconciliation instead of silently taking the plain path.
          reconcileAppliedRefresh();
          return;
        }
        if (!canWriteDraft()) {
          publish();
          reconcileAppliedRefresh();
          return;
        }
        clearInterruptedWrite();
        if (interruptedRaw !== null && state.configSnapshot?.raw !== interruptedRaw) {
          const snapshotRaw = state.configSnapshot?.raw;
          const unchanged = draftBefore && snapshotRaw === draftBefore.originalRaw;
          if (draftBefore && unchanged && !draftBefore.dirty) {
            resetConfigPendingChanges(state);
          }
          // Original bytes do not fence a delayed commit; foreign bytes do not acknowledge it.
          const foreign = typeof snapshotRaw === "string" && !unchanged;
          if (foreign) {
            state.configFormDirty = true;
          }
          state.configAutoSaveStatus = foreign ? "conflict" : "error";
          state.lastError = foreign
            ? "config changed since last load; re-run config.get and retry"
            : t("configView.writeUnconfirmed");
          publish();
          reconcileAppliedRefresh();
          return;
        }
        if (interrupted?.operation === "apply" && unacknowledgedDraftWrite() === interrupted) {
          // Persisted bytes alone do not settle a failed runtime Apply.
          state.configAutoSaveStatus = "error";
          state.lastError ??= t("configView.writeUnconfirmed");
          publish();
          reconcileAppliedRefresh();
          return;
        }
        // If the interrupted write DID commit, the fresh snapshot is
        // exactly its bytes. Rebase a surviving draft onto the fresh hash
        // so the retry doesn't false-conflict against our own write. Any
        // other server content keeps the old base and conflicts instead
        // of clobbering a foreign writer.
        if (interruptedRaw !== null && state.configSnapshot?.raw === interruptedRaw) {
          if (state.configSnapshot.appliedConfigHash === undefined) {
            state.configNeedsApply = true;
          }
          const pendingDraft = state.configFormDirty ? captureDraft() : draftBefore;
          // Rebase originals and hash together, then retain newer edits or
          // a pre-ack revert. Raw bytes and mode stay manual-save-only.
          if (pendingDraft && pendingDraft.submittedRaw !== interruptedRaw) {
            rebaseConfigDraft(state);
            state.configForm = pendingDraft.form;
            state.configRaw = pendingDraft.raw;
            state.configFormMode = pendingDraft.mode;
            state.configFormDirty = true;
            pauseAutoSaveDraftConnection();
          } else {
            resetConfigPendingChanges(state);
            state.configAutoSaveStatus = "idle";
            clearAutoSaveDraftConnection();
          }
        }
        publish();
        reconcileAppliedRefresh();
      });
    },
    clear() {
      lastSubmission = null;
      clearInterruptedWrite();
    },
  };
}
