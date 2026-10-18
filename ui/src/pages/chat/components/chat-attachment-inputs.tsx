import { For, Show } from "solid-js";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { clickComposerInput, handleChatAttachmentFileSelect } from "./chat-attachment-inputs.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";
import { ChatCameraCapture } from "./chat-camera-capture.tsx";

export function ChatAttachmentInputs(props: ChatAttachmentControlsProps) {
  const openInput = (kind: "camera" | "photo") => (source: HTMLElement) => {
    if (!props.disabled) {
      clickComposerInput(source, `.agent-chat__${kind}-input`);
    }
  };
  return (
    <Show when={uploadsEnabled(props.uploadConfig)}>
      <ChatCameraCapture
        disabled={Boolean(props.disabled) || props.cameraActive === false}
        readSignal={props.readSignal ?? props.attachmentReads?.readSignal}
        onCapture={(file: File) => {
          if (!props.disabled) {
            appendChatAttachmentFiles([file], props);
          }
        }}
        onNativeCapture={openInput("camera")}
        onUpload={openInput("photo")}
      />
      <For each={["file", "photo", "camera"] as const}>
        {(kind) => (
          <input
            type="file"
            tabindex="-1"
            aria-hidden="true"
            accept={kind === "file" ? undefined : "image/*"}
            multiple={kind !== "camera"}
            capture={kind === "camera" ? "environment" : undefined}
            class={[`agent-chat__${kind}-input`]}
            disabled={props.disabled}
            onChange={(event) => {
              if (!props.disabled) {
                handleChatAttachmentFileSelect(event, props);
              }
            }}
          />
        )}
      </For>
    </Show>
  );
}
