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

export function needsAttachmentSourceAdmission(attachment: AttachmentItem["attachment"]): boolean {
  return (
    isLocalAssistantAttachmentSource(attachment.url) || isManagedOutgoingMediaSource(attachment.url)
  );
}

export function shouldDeferAttachmentCard(
  item: AttachmentItem,
  presentation: "inline" | "card" | "preview",
): boolean {
  const { attachment } = item;
  // Players and SVG previews retain their own control lifetimes.
  return (
    needsAttachmentSourceAdmission(attachment) &&
    resolveAttachmentImageKind(attachment) !== "svg" &&
    !(presentation === "inline" && (attachment.kind === "audio" || attachment.kind === "video")) &&
    !(presentation === "preview" && attachment.kind === "video")
  );
}

export type AttachmentAdmission = {
  observeElement?: (element: Element | undefined) => void;
  onAdmit: () => void;
};

type AttachmentAdmissionInput = {
  attachments: readonly AttachmentItem["attachment"][];
  options: ImageRenderOptions;
  render: (admission?: AttachmentAdmission) => unknown;
};

class ChatAttachmentAdmissionDirective extends AsyncDirective {
  private input: AttachmentAdmissionInput | undefined;
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
  private readonly observeElement = (element: Element | undefined) => {
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

  override render(input: AttachmentAdmissionInput) {
    const { attachments, options } = input;
    const key = JSON.stringify([
      attachments.map((attachment) => [attachment.url, attachment.artifactId]),
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
    return html`${keyed(key, input.render({ observeElement: this.admitted ? undefined : this.observeElement, onAdmit: this.admit }))}`;
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
