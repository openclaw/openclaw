import { createComponent } from "solid-js";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import { ChatAttachmentAdmission } from "./chat-message-attachment-admission-solid.tsx";
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

type LegacyAdmissionProps = {
  attachments: readonly AttachmentItem["attachment"][];
  options: ImageRenderOptions;
  render: (admission?: AttachmentAdmission) => unknown;
};
function LegacyAdmission(props: LegacyAdmissionProps) {
  return createComponent(ChatAttachmentAdmission, {
    get attachments() {
      return props.attachments;
    },
    get options() {
      return props.options;
    },
    render: (admission) =>
      createComponent(LitContent, {
        get value() {
          return props.render(admission);
        },
      }),
  });
}
export function renderChatAttachmentAdmission(input: LegacyAdmissionProps) {
  return solidContent(LegacyAdmission, input);
}
