import {
  action,
  createMemo,
  createOptimistic,
  createStore,
  lazy,
  Loading,
  onCleanup,
  Show,
} from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionRefreshOutcome } from "../../lib/sessions/session-capability.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  chatProviderReviewRow,
  holdProviderReviewQueuedInputs,
  type ChatProviderReview,
} from "./chat-provider-review.ts";
import { isTerminalFailureChatSendAck, normalizeChatSendAck } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";

const ProviderReviewModal = lazy(() => import("../../components/modal-dialog.ts"), {
  export: "ModalDialog",
});

type ReviewBinding = {
  state: ChatHost;
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  client: ChatHost["client"];
  connectionEpoch: number;
  connectionGeneration: number | undefined;
  review: ChatProviderReview;
  idempotencyKey: string;
  attemptedRunId: string | null;
  accepted: boolean;
  continuing: boolean;
  checking: boolean;
};

type ReviewPresentation = {
  open: boolean;
  loading: boolean;
  submitted: boolean;
  error: string | null;
  failedAttemptId: string | null;
};

export function createChatProviderReview(deps: {
  source: () => { state: ChatHost; canWrite: boolean } | undefined;
  readState: () => ChatHost | undefined;
}) {
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const matches = (binding: ReviewBinding, state = deps.readState()) => {
    const row = state && chatProviderReviewRow(state);
    const review = row?.providerReview;
    return (
      state === binding.state &&
      state.connected &&
      state.client === binding.client &&
      state.connectionEpoch === binding.connectionEpoch &&
      state.client?.connectionGeneration === binding.connectionGeneration &&
      state.sessionKey === binding.sessionKey &&
      resolveUiSelectedSessionAgentId(state) === binding.agentId &&
      row?.sessionId === binding.sessionId &&
      (!state.currentSessionId || state.currentSessionId === binding.sessionId) &&
      review?.id === binding.review.id &&
      review.runId === binding.review.runId &&
      review.explanation === binding.review.explanation &&
      review.continuationMessage === binding.review.continuationMessage &&
      review.canContinue === binding.review.canContinue
    );
  };
  const binding = createMemo<ReviewBinding | null>((previous) => {
    const state = deps.source()?.state;
    const row = state && chatProviderReviewRow(state);
    if (!state?.connected || !row?.sessionId || !row.providerReview) {
      return null;
    }
    if (previous && matches(previous, state)) {
      return previous;
    }
    return {
      state,
      sessionKey: state.sessionKey,
      sessionId: row.sessionId,
      agentId: resolveUiSelectedSessionAgentId(state),
      client: state.client,
      connectionEpoch: state.connectionEpoch,
      connectionGeneration: state.client?.connectionGeneration,
      review: row.providerReview,
      idempotencyKey: generateUUID(),
      attemptedRunId: null,
      accepted: false,
      continuing: false,
      checking: false,
    };
  });
  const failureMessage = (error?: string) =>
    [t("chat.providerReview.continuationFailed"), error ? formatUiError(error) : null]
      .filter(Boolean)
      .join(" ");
  // Each review owns its transaction state so a retired request cannot hold its replacement.
  const activity = createMemo(() => {
    const current = binding();
    if (!current) {
      return null;
    }
    const [pending, setPending] = createOptimistic(false);
    const [checking, setChecking] = createOptimistic(false);
    const [presentation, setPresentation] = createStore<ReviewPresentation>(
      (draft) => {
        const source = deps.source();
        const row = source && chatProviderReviewRow(source.state);
        if (
          !pending() &&
          !checking() &&
          !current.continuing &&
          !current.checking &&
          current.attemptedRunId &&
          draft.failedAttemptId !== current.attemptedRunId &&
          row?.lastRunId === current.attemptedRunId &&
          row.hasActiveRun === false &&
          !row.activeRunIds?.length &&
          (row.status === "failed" || row.status === "timeout" || row.status === "killed")
        ) {
          draft.submitted = false;
          draft.error = failureMessage(row.lastRunError);
          draft.failedAttemptId = current.attemptedRunId;
        }
      },
      {
        open: false,
        loading: false,
        submitted: false,
        error: null,
        failedAttemptId: null,
      },
    );
    return { current, presentation, setPresentation, pending, setPending, checking, setChecking };
  });
  type ReviewActivity = NonNullable<ReturnType<typeof activity>>;
  const isCurrent = (current: ReviewBinding) =>
    !disposed && binding() === current && matches(current);
  const update = (active: ReviewActivity | null, patch: Partial<ReviewPresentation>) => {
    if (active && isCurrent(active.current)) {
      active.setPresentation((draft) => {
        Object.assign(draft, patch);
      });
    }
  };
  const recordFailedAttempt = (active: ReviewActivity, error: string) => {
    const current = active.current;
    current.accepted = false;
    current.attemptedRunId = null;
    // A terminal receipt owns the old key; another explicit click gets a fresh one.
    current.idempotencyKey = generateUUID();
    update(active, { submitted: false, error, failedAttemptId: null });
  };
  const checkStatus = action(function* (active: ReviewActivity) {
    const current = active.current;
    active.setChecking(true);
    update(active, { error: null });
    try {
      // Owner notifications must publish outside this held presentation transaction.
      const outcome: SessionRefreshOutcome | undefined = yield Promise.resolve().then(() => {
        if (isCurrent(current)) {
          return current.state.sessions.reconcileMutation(current.agentId);
        }
        return undefined;
      });
      if (outcome?.status === "failed") {
        update(active, { error: t("chat.providerReview.refreshFailed") });
      }
    } catch {
      update(active, { error: t("chat.providerReview.refreshFailed") });
    } finally {
      current.checking = false;
    }
  });
  const refresh = (active: ReviewActivity | null) => {
    if (
      !active ||
      !isCurrent(active.current) ||
      !active.current.accepted ||
      active.current.checking
    ) {
      return Promise.resolve();
    }
    active.current.checking = true;
    return checkStatus(active);
  };
  const continueReview = action(function* (active: ReviewActivity) {
    const current = active.current;
    try {
      if (!isCurrent(current) || !deps.source()?.canWrite) {
        return;
      }
      current.attemptedRunId = current.idempotencyKey;
      active.setPending(true);
      update(active, { error: null });
      const result: unknown = yield current.client!.request("sessions.providerReview.continue", {
        sessionKey: current.sessionKey,
        ...(current.agentId ? { agentId: current.agentId } : {}),
        sessionId: current.sessionId,
        reviewId: current.review.id,
        idempotencyKey: current.idempotencyKey,
      });
      if (!isCurrent(current)) {
        return;
      }
      const ack = normalizeChatSendAck(result, current.idempotencyKey);
      if (isTerminalFailureChatSendAck(ack)) {
        recordFailedAttempt(active, failureMessage());
        return;
      }
      current.attemptedRunId = ack.runId;
      current.accepted = true;
      update(active, { submitted: true });
      // A transport ACK does not clear the pause. Only the canonical row can do that.
      yield refresh(active);
    } catch (error) {
      update(active, { error: formatUiError(error) });
    } finally {
      current.continuing = false;
    }
  });
  const view = createMemo(() => {
    const active = activity();
    const current = active?.current;
    const source = deps.source();
    const pending = active?.pending() ?? false;
    const refreshing = active?.checking() ?? false;
    return {
      open: active?.presentation.open ?? false,
      loading: active?.presentation.loading ?? false,
      pending,
      refreshing,
      submitted: refreshing || (!pending && (active?.presentation.submitted ?? false)),
      error: pending || refreshing ? null : (active?.presentation.error ?? null),
      review: source && chatProviderReviewRow(source.state)?.providerReview,
      dialog: active?.presentation.open && current && matches(current) ? current : null,
      available: Boolean(current),
      canWrite: source?.canWrite ?? false,
    };
  });
  return {
    view,
    async open() {
      const active = activity();
      if (!active || !isCurrent(active.current) || active.presentation.loading) {
        return;
      }
      update(active, { loading: true });
      try {
        await ProviderReviewModal.preload();
        update(active, { open: true });
      } catch (error) {
        update(active, { error: formatUiError(error) });
      } finally {
        update(active, { loading: false });
      }
    },
    close: () => update(activity(), { open: false }),
    refresh() {
      const active = activity();
      if (active?.presentation.open) {
        void refresh(active);
      }
    },
    async acknowledge() {
      const active = activity();
      if (
        !active ||
        !isCurrent(active.current) ||
        !active.presentation.open ||
        !deps.source()?.canWrite ||
        active.current.continuing ||
        !active.current.review.canContinue ||
        !active.current.review.explanation?.trim() ||
        !active.current.review.continuationMessage?.trim()
      ) {
        return;
      }
      const current = active.current;
      const failedAttempt =
        current.attemptedRunId !== null &&
        active.presentation.failedAttemptId === current.attemptedRunId;
      if (current.accepted && !failedAttempt) {
        return;
      }
      if (failedAttempt) {
        recordFailedAttempt(active, active.presentation.error ?? failureMessage());
      }
      if (!holdProviderReviewQueuedInputs(current.state, current.sessionKey, current.agentId)) {
        update(active, { error: t("chat.providerReview.queueHoldFailed") });
        return;
      }
      current.continuing = true;
      // Flush the owner's immediate queue hold before opening the presentation transaction.
      return Promise.resolve().then(() => continueReview(active));
    },
  };
}

export type ChatProviderReviewOwner = ReturnType<typeof createChatProviderReview>;
type ProviderReviewViewProps = { owner: ChatProviderReviewOwner };

export function ChatProviderReviewNotice(props: ProviderReviewViewProps) {
  const view = () => props.owner.view();
  return (
    <Show when={view().review} keyed>
      {(review) => {
        const hasFindings = Boolean(review.explanation?.trim());
        return (
          <div
            class="chat-composer-neighbor-card chat-composer-neighbor-card--warn chat-provider-review"
            role="alert"
          >
            <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
              <Icon name="alertTriangle" />
            </span>
            <div class="chat-composer-neighbor-card__copy">
              <strong>
                {t(
                  review.canContinue
                    ? "chat.providerReview.pausedTitle"
                    : "chat.providerReview.stoppedTitle",
                )}
              </strong>
              <span>
                {t(
                  hasFindings
                    ? review.canContinue
                      ? "chat.providerReview.pausedBody"
                      : "chat.providerReview.stoppedWithFindingsBody"
                    : "chat.providerReview.stoppedBody",
                )}
              </span>
              {view().error && !view().dialog ? <span>{view().error}</span> : null}
            </div>
            {hasFindings ? (
              <button
                class="btn btn--sm"
                type="button"
                disabled={view().loading || !view().available}
                onClick={() => void props.owner.open()}
              >
                {t("chat.providerReview.review")}
              </button>
            ) : null}
          </div>
        );
      }}
    </Show>
  );
}

export function ChatProviderReviewDialog(props: ProviderReviewViewProps) {
  const view = () => props.owner.view();
  return (
    <Show when={view().dialog} keyed>
      {(binding) => {
        let closeButton!: HTMLButtonElement;
        const review = binding.review;
        const canContinue =
          review.canContinue &&
          Boolean(review.explanation?.trim() && review.continuationMessage?.trim());
        return (
          <Loading>
            <ProviderReviewModal
              initialFocus={() => closeButton}
              label={t("chat.providerReview.review")}
              onModal-cancel={() => props.owner.close()}
            >
              <section class="exec-approval-card chat-provider-review-dialog">
                <h2 class="exec-approval-title">
                  {t(
                    canContinue
                      ? "chat.providerReview.pausedTitle"
                      : "chat.providerReview.stoppedTitle",
                  )}
                </h2>
                <div class="chat-provider-review-dialog__content">
                  {canContinue ? (
                    <>
                      <h3>{t("chat.providerReview.continuationTitle")}</h3>
                      <p>{t("chat.providerReview.continuationBody")}</p>
                      <blockquote class="chat-provider-review-dialog__text">
                        {review.continuationMessage}
                      </blockquote>
                    </>
                  ) : (
                    <p>{t("chat.providerReview.noContinuation")}</p>
                  )}
                  <h3>{t("chat.providerReview.findings")}</h3>
                  <div class="chat-provider-review-dialog__text">{review.explanation}</div>
                  <p>
                    {t(
                      canContinue
                        ? "chat.providerReview.queueHelp"
                        : "chat.providerReview.queueStopped",
                    )}
                  </p>
                  {view().error ? (
                    <p class="callout danger" role="alert">
                      {view().error}
                    </p>
                  ) : null}
                  {view().submitted && !view().error ? (
                    <p role="status">
                      {t(
                        view().refreshing
                          ? "chat.providerReview.checkingStatus"
                          : "chat.providerReview.waiting",
                      )}
                    </p>
                  ) : null}
                </div>
                <openclaw-modal-actions class="exec-approval-actions">
                  <button
                    ref={(element) => {
                      closeButton = element;
                    }}
                    type="button"
                    class="btn"
                    autofocus
                    onClick={() => props.owner.close()}
                  >
                    {t("common.close")}
                  </button>
                  {view().submitted ? (
                    <button
                      type="button"
                      class="btn"
                      disabled={view().refreshing}
                      onClick={() => props.owner.refresh()}
                    >
                      {t(
                        view().refreshing
                          ? "chat.providerReview.checkingStatus"
                          : "chat.providerReview.checkStatus",
                      )}
                    </button>
                  ) : null}
                  {canContinue ? (
                    <button
                      type="button"
                      class="btn primary"
                      disabled={!view().canWrite || view().pending || view().submitted}
                      onClick={() => void props.owner.acknowledge()}
                    >
                      {t(
                        view().pending && !view().submitted
                          ? "chat.providerReview.continuing"
                          : "chat.providerReview.acknowledge",
                      )}
                    </button>
                  ) : null}
                </openclaw-modal-actions>
              </section>
            </ProviderReviewModal>
          </Loading>
        );
      }}
    </Show>
  );
}
