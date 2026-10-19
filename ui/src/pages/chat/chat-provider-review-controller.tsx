import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  chatProviderReviewRow,
  holdProviderReviewQueuedInputs,
  type ChatProviderReview,
} from "./chat-provider-review.ts";
import { isTerminalFailureChatSendAck, normalizeChatSendAck } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";

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
};

type ReviewPresentation = {
  binding: ReviewBinding | null;
  open: boolean;
  loading: boolean;
  pending: boolean;
  submitted: boolean;
  refreshing: boolean;
  error: string | null;
  failedAttemptId: string | null;
};

export function createChatProviderReview(deps: {
  source: () => { state: ChatHost; canWrite: boolean } | undefined;
  readState: () => ChatHost | undefined;
}) {
  let disposed = false;
  let continuationInFlight: ReviewBinding | null = null;
  let refreshInFlight: ReviewBinding | null = null;
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
    };
  });
  const failureMessage = (error?: string) =>
    [t("chat.providerReview.continuationFailed"), error ? formatUiError(error) : null]
      .filter(Boolean)
      .join(" ");
  // A new review resets local presentation; terminal receipts remain until an explicit retry.
  const [presentation, setPresentation] = createSignal<ReviewPresentation>((previous) => {
    const current = binding();
    const source = deps.source();
    if (previous?.binding !== current) {
      return {
        binding: current,
        open: false,
        loading: false,
        pending: false,
        submitted: false,
        refreshing: false,
        error: null,
        failedAttemptId: null,
      };
    }
    const row = source && chatProviderReviewRow(source.state);
    return current &&
      !previous.pending &&
      !previous.refreshing &&
      continuationInFlight !== current &&
      refreshInFlight !== current &&
      current.attemptedRunId &&
      previous.failedAttemptId !== current.attemptedRunId &&
      row?.lastRunId === current.attemptedRunId &&
      row.hasActiveRun === false &&
      !row.activeRunIds?.length &&
      (row.status === "failed" || row.status === "timeout" || row.status === "killed")
      ? {
          ...previous,
          submitted: false,
          error: failureMessage(row.lastRunError),
          failedAttemptId: current.attemptedRunId,
        }
      : previous;
  });
  const isCurrent = (current: ReviewBinding) =>
    !disposed && binding() === current && matches(current);
  const update = (
    current: ReviewBinding | null,
    patch: Partial<Omit<ReviewPresentation, "binding">>,
  ) => {
    if (current && isCurrent(current)) {
      setPresentation((previous) => ({ ...previous, ...patch }));
    }
  };
  const recordFailedAttempt = (current: ReviewBinding, error: string) => {
    current.accepted = false;
    current.attemptedRunId = null;
    // A terminal receipt owns the old key; another explicit click gets a fresh one.
    current.idempotencyKey = generateUUID();
    update(current, { submitted: false, error, failedAttemptId: null });
  };
  const refresh = async (current: ReviewBinding | null) => {
    if (!current || !isCurrent(current) || !current.accepted || refreshInFlight === current) {
      return;
    }
    refreshInFlight = current;
    update(current, { refreshing: true, error: null });
    try {
      const outcome = await current.state.sessions.reconcileMutation(current.agentId);
      if (outcome.status === "failed") {
        update(current, { error: t("chat.providerReview.refreshFailed") });
      }
    } catch {
      update(current, { error: t("chat.providerReview.refreshFailed") });
    } finally {
      if (refreshInFlight === current) {
        refreshInFlight = null;
      }
      update(current, { refreshing: false });
    }
  };
  const view = createMemo(() => {
    const activity = presentation();
    const current = binding();
    const source = deps.source();
    return {
      ...activity,
      review: source && chatProviderReviewRow(source.state)?.providerReview,
      dialog: activity.open && current && matches(current) ? current : null,
      available: Boolean(current),
      canWrite: source?.canWrite ?? false,
    };
  });
  return {
    view,
    async open() {
      const current = binding();
      if (!current || !isCurrent(current) || presentation().loading) {
        return;
      }
      update(current, { loading: true });
      try {
        await import("../../components/modal-dialog.ts");
        update(current, { open: true });
      } catch (error) {
        update(current, { error: formatUiError(error) });
      } finally {
        update(current, { loading: false });
      }
    },
    close: () => update(binding(), { open: false }),
    refresh: () => void refresh(view().dialog),
    async acknowledge() {
      const current = binding();
      if (
        !current ||
        !isCurrent(current) ||
        !presentation().open ||
        !deps.source()?.canWrite ||
        continuationInFlight === current ||
        !current.review.canContinue ||
        !current.review.explanation?.trim() ||
        !current.review.continuationMessage?.trim()
      ) {
        return;
      }
      const activity = presentation();
      const failedAttempt =
        current.attemptedRunId !== null && activity.failedAttemptId === current.attemptedRunId;
      if (current.accepted && !failedAttempt) {
        return;
      }
      if (failedAttempt) {
        // Retire a failed attempt only when another explicit acknowledgment starts.
        recordFailedAttempt(current, activity.error ?? failureMessage());
      }
      if (!holdProviderReviewQueuedInputs(current.state, current.sessionKey, current.agentId)) {
        update(current, { error: t("chat.providerReview.queueHoldFailed") });
        return;
      }
      // Request claims stay synchronous: Solid's presentation writes are deferred.
      continuationInFlight = current;
      current.attemptedRunId = current.idempotencyKey;
      update(current, { pending: true, error: null });
      try {
        const result = await current.client!.request("sessions.providerReview.continue", {
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
          recordFailedAttempt(current, failureMessage());
          return;
        }
        current.attemptedRunId = ack.runId;
        current.accepted = true;
        update(current, { submitted: true });
        // A transport ACK does not clear the pause. Only the canonical row can do that.
        await refresh(current);
      } catch (error) {
        update(current, { error: formatUiError(error) });
      } finally {
        if (continuationInFlight === current) {
          continuationInFlight = null;
        }
        update(current, { pending: false });
      }
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
          <openclaw-modal-dialog
            prop:initialFocus={() => closeButton}
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
          </openclaw-modal-dialog>
        );
      }}
    </Show>
  );
}
