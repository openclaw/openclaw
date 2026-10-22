import { For, onSettled, Show } from "solid-js";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import {
  type ChatAttachmentInputHandle,
  handleChatAttachmentFileSelect,
} from "./chat-attachment-inputs.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";
import { ChatCameraCapture, type OpenClawChatCameraCapture } from "./chat-camera-capture.tsx";

export function ChatAttachmentInputs(
  props: ChatAttachmentControlsProps & { inputHandle: ChatAttachmentInputHandle },
) {
  const openInput = (kind: "camera" | "photo") => () => {
    if (!props.disabled) {
      props.inputHandle.openNative(kind);
    }
  };
  return (
    <Show when={uploadsEnabled(props.uploadConfig)}>
      {(_enabled) => {
        const inputs: Partial<Record<"file" | "photo" | "camera", HTMLInputElement>> = {};
        let camera: OpenClawChatCameraCapture | undefined;
        onSettled(() => props.inputHandle.bindInputs({ inputs, camera }));
        return (
          <>
            <ChatCameraCapture
              ref={(element) => {
                camera = element;
              }}
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
                  ref={(element) => {
                    inputs[kind] = element;
                  }}
                  type="file"
                  tabindex="-1"
                  aria-hidden="true"
                  accept={kind === "file" && !props.imagesOnly ? undefined : "image/*"}
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
          </>
        );
      }}
    </Show>
  );
}
