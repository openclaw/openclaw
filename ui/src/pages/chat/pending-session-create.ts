import { html } from "lit";
import { property, state } from "lit/decorators.js";
import type { ApplicationContext } from "../../app/context.ts";
import { readDeletedSessionStartup } from "../../app/deleted-session-startup.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderNewSessionBody } from "../new-session/draft-body.ts";
import { chatStartupStatusLabel } from "./chat-run-startup.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";
import { buildLocalUserMessage } from "./user-message-content.ts";

registerNewSessionSetupEnglish();

/** Admission preview owns display only; real pane controllers mount after acceptance. */
class PendingSessionCreate extends OpenClawLightDomElement {
  @property({ attribute: false }) context!: ApplicationContext;
  @property() sessionKey = "";
  @state() private image: ImageLightboxItem | null = null;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.gateway,
      (gateway, notify) =>
        gateway.subscribe(() => {
          this.closeImage();
          notify();
        }),
    )
    .watch(
      () => this.context?.chatSubmissions,
      (submissions, notify) =>
        submissions.subscribeCreate(() => {
          this.closeImage();
          notify();
        }),
    )
    .watch(
      () => this.context?.placementStartup,
      (startup, notify) => startup.subscribe(notify),
    );
  private readonly closeImage = () => {
    this.image?.release?.();
    this.image = null;
  };
  override disconnectedCallback() {
    this.closeImage();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }
  override render() {
    const snapshot = this.context.gateway.snapshot;
    const identity = snapshot.selfUser?.identity;
    const startup = readDeletedSessionStartup(this.context, this.sessionKey);
    const failed = startup?.phase === "failed";
    const cancelled = startup?.phase === "cancelled";
    const checking = startup?.action === "check-delivery";
    const submitting = !failed && !cancelled;
    const turn = startup?.initialTurn;
    const errorAction =
      failed && startup
        ? startup.discardAndReload
          ? {
              label: t("newSession.discardUnsavedAndReload"),
              onClick: startup.discardAndReload,
            }
          : startup.retryable
            ? {
                label: t(checking ? "chat.queue.checkDelivery" : "common.retry"),
                onClick: () => this.context.placementStartup.retry(startup.sessionKey),
              }
            : undefined
        : undefined;
    const pendingMessage = turn
      ? buildLocalUserMessage(
          {
            text: turn.text,
            mentions: turn.mentions,
            attachments: turn.attachments,
            createdAt: turn.createdAt,
          },
          "available",
        )
      : this.context.chatSubmissions.readCreateMessage(this.sessionKey);
    return html`<section class="chat" aria-busy=${String(submitting)}>
        ${renderNewSessionBody({
          error: failed
            ? (startup.error ??
              t(checking ? "chat.queue.checkDeliveryHelp" : "newSession.createFailed"))
            : null,
          errorAction: errorAction
            ? {
                ...errorAction,
                disabled: snapshot.phase !== "connected" || !snapshot.client?.recoveryScopeReady,
              }
            : undefined,
          pendingMessage,
          userId: identity?.type === "profile" ? identity.id : null,
          submitting,
          statusLabel:
            snapshot.phase === "connected"
              ? chatStartupStatusLabel(null, startup)
              : t("connection.reconnecting"),
          completion: cancelled
            ? { label: startup.error ?? t("newSession.placementCancelled") }
            : failed
              ? { label: t(checking ? "chat.queue.deliveryUnconfirmed" : "chat.queue.notSent") }
              : undefined,
          renderDraft: () => html`<div role="status">${t("connection.reconnecting")}</div>`,
          onOpenImage: (item) => {
            this.closeImage();
            this.image = item;
          },
        })}
      </section>
      ${renderChatImageLightbox(this.image, this.closeImage)}`;
  }
}
if (!customElements.get("openclaw-pending-session-create")) {
  customElements.define("openclaw-pending-session-create", PendingSessionCreate);
}
