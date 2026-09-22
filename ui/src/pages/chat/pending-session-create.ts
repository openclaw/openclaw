import { html } from "lit";
import { property, state } from "lit/decorators.js";
import type { ApplicationContext } from "../../app/context.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderNewSessionBody } from "../new-session/draft-body.ts";
import { renderChatImageLightbox } from "./components/chat-image-lightbox.ts";

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
    const pendingMessage = this.context.chatSubmissions.readCreateMessage(this.sessionKey);
    return html`<section class="chat" aria-busy="true">
        ${renderNewSessionBody({
          error: null,
          pendingMessage,
          userId: identity?.type === "profile" ? identity.id : null,
          submitting: true,
          renderDraft: () => html`<div role="status">${t("newSession.starting")}</div>`,
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
