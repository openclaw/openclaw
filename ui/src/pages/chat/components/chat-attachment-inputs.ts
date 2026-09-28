// Shared camera, photo, and file entry points for chat and New Session.
import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { useSingleAttachmentPicker } from "./chat-attachment-picker-policy.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";
import "./chat-camera-capture.ts";

const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,video/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";
function clickComposerInput(target: HTMLElement, selector: string) {
  target.closest("details")?.removeAttribute("open");
  target
    .closest(".agent-chat__composer-shell, .new-session-page__composer")
    ?.querySelector<HTMLInputElement>(selector)
    ?.click();
}

function handleChatAttachmentFileSelect(e: Event, props: ChatAttachmentControlsProps) {
  const input = e.target;
  if (!(input instanceof HTMLInputElement)) {
    return;
  }
  const files = [...(input.files ?? [])];
  input.value = "";
  appendChatAttachmentFiles(files, props);
}

export function renderChatAttachmentInputs(props: ChatAttachmentControlsProps) {
  if (!uploadsEnabled(props.uploadConfig)) {
    return nothing;
  }
  return html`
    <openclaw-chat-camera-capture
      .disabled=${Boolean(props.disabled) || props.cameraActive === false}
      .readSignal=${props.readSignal ?? props.attachmentReads?.readSignal}
      .onCapture=${(file: File) => {
        if (!props.disabled) {
          appendChatAttachmentFiles([file], props);
        }
      }}
      .onUpload=${(source: HTMLElement) => {
        if (!props.disabled) {
          clickComposerInput(source, ".agent-chat__photo-input");
        }
      }}
    ></openclaw-chat-camera-capture>
    ${(["file", "photo"] as const).map(
      (kind) => html`
        <input
          type="file"
          accept=${kind === "file" ? CHAT_ATTACHMENT_ACCEPT : "image/*"}
          multiple
          class=${`agent-chat__${kind}-input`}
          ?disabled=${props.disabled}
          @change=${(event: Event) => {
            if (!props.disabled) {
              handleChatAttachmentFileSelect(event, props);
            }
          }}
        />
      `,
    )}
  `;
}

export function handleChatAttachmentMenuSelection(
  event: CustomEvent<{ item: { value?: string } }>,
): boolean {
  const value = event.detail.item.value;
  if (value !== "camera" && value !== "photo" && value !== "file") {
    return false;
  }
  const target = event.currentTarget;
  if (target instanceof HTMLElement) {
    if (value === "camera") {
      target
        .closest(".agent-chat__composer-shell, .new-session-page__composer")
        ?.querySelector("openclaw-chat-camera-capture")
        ?.show();
    } else {
      clickComposerInput(target, `.agent-chat__${value}-input`);
    }
  }
  return true;
}

export function renderChatAttachmentMenuTrigger(
  disabled: boolean | undefined,
  hasOverrides = false,
) {
  return html`
    <button
      slot="trigger"
      type="button"
      class="agent-chat__input-btn agent-chat__input-btn--attach ${
        hasOverrides ? "agent-chat__input-btn--has-overrides" : ""
      }"
      aria-label=${t("chat.composer.addAttachment")}
      ?disabled=${disabled}
      title=${t("chat.composer.addAttachment")}
    >
      ${icons.plus}
    </button>
  `;
}

export function renderChatAttachmentMenuOptions(fileIcon = icons.folder) {
  const options = [
    { value: "camera", icon: icons.camera, label: t("chat.composer.takePhoto") },
    ...(useSingleAttachmentPicker()
      ? [{ value: "file", icon: fileIcon, label: t("chat.composer.attach") }]
      : [
          { value: "photo", icon: icons.image, label: t("chat.composer.attachPhoto") },
          { value: "file", icon: fileIcon, label: t("chat.composer.attachFileOption") },
        ]),
  ];
  return options.map(
    ({ value, icon, label }) => html`
      <wa-dropdown-item class="agent-chat__attach-menu-option" value=${value}>
        <span slot="icon" aria-hidden="true">${icon}</span>
        <span>${label}</span>
      </wa-dropdown-item>
    `,
  );
}
