// Shared camera, photo, and file entry points for chat and New Session.
import { html, nothing } from "lit";
import "../../../components/web-awesome.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";
import "./chat-camera-capture.tsx";

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
  const openInput = (kind: "camera" | "photo") => (source: HTMLElement) => {
    if (!props.disabled) {
      clickComposerInput(source, `.agent-chat__${kind}-input`);
    }
  };
  return html`
    <openclaw-chat-camera-capture
      .disabled=${Boolean(props.disabled) || props.cameraActive === false}
      .readSignal=${props.readSignal ?? props.attachmentReads?.readSignal}
      .onCapture=${(file: File) => {
        if (!props.disabled) {
          appendChatAttachmentFiles([file], props);
        }
      }}
      .onNativeCapture=${openInput("camera")}
      .onUpload=${openInput("photo")}
    ></openclaw-chat-camera-capture>
    ${(["file", "photo", "camera"] as const).map(
      (kind) => html`
        <input
          type="file"
          accept=${kind === "file" ? nothing : "image/*"}
          ?multiple=${kind !== "camera"}
          capture=${kind === "camera" ? "environment" : nothing}
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
