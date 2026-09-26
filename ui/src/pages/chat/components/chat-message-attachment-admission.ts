import { html, noChange } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import { keyed } from "lit/directives/keyed.js";
import { observeChatAttachmentViewport } from "./chat-attachment-viewport.ts";
import { isManagedOutgoingMediaSource } from "./chat-message-attachment-availability.ts";
import { isLocalAssistantAttachmentSource } from "./chat-message-local-media.ts";
import {
  resolveAttachmentImageKind,
  type AttachmentItem,
  type ImageRenderOptions,
} from "./chat-message-media.ts";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";

export function shouldDeferAttachmentCard(
  item: AttachmentItem,
  presentation: "inline" | "card" | "preview",
): boolean {
  const { attachment } = item;
  // Players, SVG previews, and text chips retain their own control lifetimes.
  return (
    (isLocalAssistantAttachmentSource(attachment.url) ||
      isManagedOutgoingMediaSource(attachment.url)) &&
    resolveAttachmentImageKind(attachment) !== "svg" &&
    !(presentation === "inline" && (attachment.kind === "audio" || attachment.kind === "video")) &&
    !(presentation === "preview" && attachment.kind === "video") &&
    !(presentation === "card" && isSentPastedTextAttachment(item))
  );
}

export type AttachmentCardAdmission = {
  observeCard?: (element: Element | undefined) => void;
  onFocus: () => void;
};

type AttachmentAdmission = {
  attachment: AttachmentItem["attachment"];
  options: ImageRenderOptions;
  render: (admission?: AttachmentCardAdmission) => unknown;
};

class ChatAttachmentAdmissionDirective extends AsyncDirective {
  private input: AttachmentAdmission | undefined;
  private key = "";
  private generation = 0;
  private admitted = false;
  private stopObserving: (() => void) | undefined;
  private readonly admit = () => {
    if (this.isConnected && !this.admitted) {
      this.admitted = true;
      this.stopObserving?.();
      this.stopObserving = undefined;
      this.refresh();
    }
  };
  private readonly observeCard = (element: Element | undefined) => {
    this.stopObserving?.();
    this.stopObserving = undefined;
    if (!element || !this.isConnected || this.admitted) {
      return;
    }
    const generation = this.generation;
    this.stopObserving = observeChatAttachmentViewport(element, () => {
      if (generation === this.generation) {
        this.admit();
      }
    });
  };
  private readonly refresh = () => {
    if (this.isConnected && this.input) {
      this.setValue(this.render(this.input));
    }
  };

  override render(input: AttachmentAdmission) {
    const { attachment, options } = input;
    const key = JSON.stringify([
      attachment.url,
      attachment.artifactId,
      options.sessionKey,
      options.agentId,
      options.connectionEpoch,
      options.resourceBasePath,
      options.authToken,
      options.policyKey,
    ]);
    if (key !== this.key) {
      this.generation++;
      this.stopObserving?.();
      this.stopObserving = undefined;
      this.admitted = false;
    }
    this.key = key;
    this.input = input;
    if (!this.isConnected) {
      return noChange;
    }
    if (typeof IntersectionObserver !== "function") {
      this.admitted = true;
    }
    return html`${keyed(key, input.render({ observeCard: this.admitted ? undefined : this.observeCard, onFocus: this.admit }))}`;
  }

  protected override disconnected() {
    this.generation++;
    this.stopObserving?.();
    this.stopObserving = undefined;
    this.admitted = false;
  }

  protected override reconnected() {
    this.refresh();
  }
}

export const renderChatAttachmentAdmission = directive(ChatAttachmentAdmissionDirective);
