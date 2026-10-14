import { createComponent } from "solid-js";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import type { AttachmentAdmission } from "./chat-message-attachment-admission-model.ts";
import { ChatAttachmentAdmission } from "./chat-message-attachment-admission-solid.tsx";
import type { AttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";

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
