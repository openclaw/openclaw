import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveUiSelectedSessionAgentId } from "../../lib/sessions/session-key.ts";
import { generateUUID } from "../../lib/uuid.ts";
import {
  chatProviderReviewRow,
  holdProviderReviewQueuedInputs,
  type ChatProviderReview,
} from "./chat-provider-review.ts";
import { isTerminalFailureChatSendAck, normalizeChatSendAck } from "./chat-send-ack.ts";
import type { ChatHost } from "./chat-send-contract.ts";

type ReviewState = ChatHost;

export class ChatProviderReviewController implements ReactiveController {
  private canWrite = false;

  private binding: {
    state: ReviewState;
    sessionKey: string;
    sessionId: string;
    agentId?: string;
    client: ReviewState["client"];
    connectionEpoch: number;
    connectionGeneration: number | undefined;
    review: ChatProviderReview;
    open: boolean;
    loading: boolean;
    pending: boolean;
    submitted: boolean;
    refreshing: boolean;
    error: string | null;
    idempotencyKey: string;
    attemptedRunId: string | null;
  } | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly readState: () => ReviewState | undefined,
  ) {
    host.addController(this);
  }

  hostDisconnected() {
    this.binding = null;
  }

  private isCurrent(binding: NonNullable<ChatProviderReviewController["binding"]>): boolean {
    const state = this.readState();
    const row = state && chatProviderReviewRow(state);
    const review = row?.providerReview;
    return (
      this.binding === binding &&
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
  }

  sync(canWrite: boolean): void {
    this.canWrite = canWrite;
    if (this.binding && this.isCurrent(this.binding)) {
      this.reconcileTerminalAttempt(this.binding);
      return;
    }
    this.binding = null;
    const state = this.readState();
    const row = state && chatProviderReviewRow(state);
    if (!state?.connected || !row?.sessionId || !row.providerReview) {
      return;
    }
    this.binding = {
      state,
      sessionKey: state.sessionKey,
      sessionId: row.sessionId,
      agentId: resolveUiSelectedSessionAgentId(state),
      client: state.client,
      connectionEpoch: state.connectionEpoch,
      connectionGeneration: state.client?.connectionGeneration,
      review: row.providerReview,
      open: false,
      loading: false,
      pending: false,
      submitted: false,
      refreshing: false,
      error: null,
      idempotencyKey: generateUUID(),
      attemptedRunId: null,
    };
  }

  private reconcileTerminalAttempt(binding: NonNullable<ChatProviderReviewController["binding"]>) {
    // An unresolved ACK or status read still owns its result; settle it before offering another attempt.
    if (binding.pending || binding.refreshing || !binding.attemptedRunId) {
      return;
    }
    const row = chatProviderReviewRow(binding.state);
    if (
      !row ||
      row.lastRunId !== binding.attemptedRunId ||
      row.hasActiveRun !== false ||
      row.activeRunIds?.length ||
      (row.status !== "failed" && row.status !== "timeout" && row.status !== "killed")
    ) {
      return;
    }
    this.recordFailedAttempt(binding, row.lastRunError);
  }

  private recordFailedAttempt(
    binding: NonNullable<ChatProviderReviewController["binding"]>,
    error?: string,
  ) {
    binding.submitted = false;
    binding.attemptedRunId = null;
    // The old key now owns a terminal receipt. Only a new explicit click may submit this fresh key.
    binding.idempotencyKey = generateUUID();
    binding.error = [
      t("chat.providerReview.continuationFailed"),
      error ? formatUiError(error) : null,
    ]
      .filter(Boolean)
      .join(" ");
  }

  private async open(binding: NonNullable<ChatProviderReviewController["binding"]>) {
    if (!this.isCurrent(binding) || binding.loading) {
      return;
    }
    binding.loading = true;
    this.host.requestUpdate();
    try {
      await import("../../components/modal-dialog.ts");
      if (this.isCurrent(binding)) {
        binding.open = true;
      }
    } catch (error) {
      if (this.isCurrent(binding)) {
        binding.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(binding)) {
        binding.loading = false;
        this.host.requestUpdate();
      }
    }
  }

  private async acknowledge(binding: NonNullable<ChatProviderReviewController["binding"]>) {
    if (
      !this.isCurrent(binding) ||
      !binding.open ||
      !this.canWrite ||
      binding.pending ||
      binding.submitted ||
      !binding.review.canContinue ||
      !binding.review.explanation?.trim() ||
      !binding.review.continuationMessage?.trim()
    ) {
      return;
    }
    if (!holdProviderReviewQueuedInputs(binding.state, binding.sessionKey, binding.agentId)) {
      binding.error = t("chat.providerReview.queueHoldFailed");
      this.host.requestUpdate();
      return;
    }
    binding.pending = true;
    binding.attemptedRunId = binding.idempotencyKey;
    binding.error = null;
    this.host.requestUpdate();
    try {
      const result = await binding.client!.request("sessions.providerReview.continue", {
        sessionKey: binding.sessionKey,
        ...(binding.agentId ? { agentId: binding.agentId } : {}),
        sessionId: binding.sessionId,
        reviewId: binding.review.id,
        idempotencyKey: binding.idempotencyKey,
      });
      if (!this.isCurrent(binding)) {
        return;
      }
      const ack = normalizeChatSendAck(result, binding.idempotencyKey);
      if (isTerminalFailureChatSendAck(ack)) {
        this.recordFailedAttempt(binding);
        return;
      }
      binding.attemptedRunId = ack.runId;
      binding.submitted = true;
      // A transport ACK does not clear the pause. Only the canonical row can do that.
      await this.refresh(binding);
    } catch (error) {
      if (this.isCurrent(binding)) {
        binding.error = formatUiError(error);
      }
    } finally {
      if (this.isCurrent(binding)) {
        binding.pending = false;
        this.host.requestUpdate();
      }
    }
  }

  private async refresh(binding: NonNullable<ChatProviderReviewController["binding"]>) {
    if (!this.isCurrent(binding) || !binding.submitted || binding.refreshing) {
      return;
    }
    binding.refreshing = true;
    binding.error = null;
    this.host.requestUpdate();
    try {
      const outcome = await binding.state.sessions.reconcileMutation(binding.agentId);
      if (this.isCurrent(binding) && outcome.status === "failed") {
        binding.error = t("chat.providerReview.refreshFailed");
      }
    } catch {
      if (this.isCurrent(binding)) {
        binding.error = t("chat.providerReview.refreshFailed");
      }
    } finally {
      if (this.isCurrent(binding)) {
        binding.refreshing = false;
        this.host.requestUpdate();
      }
    }
  }

  notice() {
    const state = this.readState();
    const review = state && chatProviderReviewRow(state)?.providerReview;
    if (!review) {
      return nothing;
    }
    const binding = this.binding;
    const hasFindings = Boolean(review.explanation?.trim());
    return html`
      <div
        class="chat-composer-neighbor-card chat-composer-neighbor-card--warn chat-provider-review"
        role="alert"
      >
        <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
          >${icons.alertTriangle}</span
        >
        <div class="chat-composer-neighbor-card__copy">
          <strong
            >${t(review.canContinue ? "chat.providerReview.pausedTitle" : "chat.providerReview.stoppedTitle")}</strong
          >
          <span
            >${t(
              hasFindings
                ? review.canContinue
                  ? "chat.providerReview.pausedBody"
                  : "chat.providerReview.stoppedWithFindingsBody"
                : "chat.providerReview.stoppedBody",
            )}</span
          >
          ${binding?.error && !binding.open ? html`<span>${binding.error}</span>` : nothing}
        </div>
        ${hasFindings ? html`<button class="btn btn--sm" type="button" ?disabled=${!binding || binding.loading} @click=${() => binding && void this.open(binding)}>${t("chat.providerReview.review")}</button>` : nothing}
      </div>
    `;
  }

  dialog() {
    const binding = this.binding;
    if (!binding?.open || !this.isCurrent(binding)) {
      return nothing;
    }
    const { review } = binding;
    const canContinue =
      review.canContinue &&
      Boolean(review.explanation?.trim() && review.continuationMessage?.trim());
    const close = () => {
      if (this.isCurrent(binding)) {
        binding.open = false;
        this.host.requestUpdate();
      }
    };
    return html`
      <openclaw-modal-dialog label=${t("chat.providerReview.review")} @modal-cancel=${close}>
        <section class="exec-approval-card chat-provider-review-dialog">
          <h2 class="exec-approval-title">
            ${t(canContinue ? "chat.providerReview.pausedTitle" : "chat.providerReview.stoppedTitle")}
          </h2>
          <div class="chat-provider-review-dialog__content">
            ${
              canContinue
                ? html`
                    <h3>${t("chat.providerReview.continuationTitle")}</h3>
                    <p>${t("chat.providerReview.continuationBody")}</p>
                    <blockquote
                      class="chat-provider-review-dialog__text"
                      .textContent=${review.continuationMessage}
                    ></blockquote>
                  `
                : html`<p>${t("chat.providerReview.noContinuation")}</p>`
            }
            <h3>${t("chat.providerReview.findings")}</h3>
            <div class="chat-provider-review-dialog__text">${review.explanation}</div>
            <p>
              ${t(canContinue ? "chat.providerReview.queueHelp" : "chat.providerReview.queueStopped")}
            </p>
            ${binding.error ? html`<p class="callout danger" role="alert">${binding.error}</p>` : nothing}
            ${binding.submitted && !binding.error ? html`<p role="status">${t(binding.refreshing ? "chat.providerReview.checkingStatus" : "chat.providerReview.waiting")}</p>` : nothing}
          </div>
          <div class="exec-approval-actions">
            <button type="button" class="btn" autofocus @click=${close}>
              ${t("common.close")}
            </button>
            ${binding.submitted ? html`<button type="button" class="btn" ?disabled=${binding.refreshing} @click=${() => void this.refresh(binding)}>${t(binding.refreshing ? "chat.providerReview.checkingStatus" : "chat.providerReview.checkStatus")}</button>` : nothing}
            ${canContinue ? html`<button type="button" class="btn primary" ?disabled=${!this.canWrite || binding.pending || binding.submitted} @click=${() => void this.acknowledge(binding)}>${t(binding.pending && !binding.submitted ? "chat.providerReview.continuing" : "chat.providerReview.acknowledge")}</button>` : nothing}
          </div>
        </section>
      </openclaw-modal-dialog>
    `;
  }
}
