import { For, onSettled, Show } from "solid-js";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import type { AttachmentInputKind, ChatAttachmentInputHandle } from "./chat-attachment-inputs.ts";
import { useNativeAttachmentCapture } from "./chat-attachment-picker-policy.ts";
import { appendChatAttachmentFiles } from "./chat-attachments.ts";
import type { OpenClawChatCameraCapture } from "./chat-camera-capture.tsx";
import "./chat-camera-capture.css";

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
        const inputs: Partial<Record<AttachmentInputKind, HTMLInputElement>> = {};
        let camera: OpenClawChatCameraCapture | undefined;
        onSettled(() => props.inputHandle.bindInputs({ inputs, camera }));
        return (
          <>
            {/* The lazy plus menu registers this retained host before camera activation. */}
            <openclaw-chat-camera-capture
              ref={(element) => {
                camera = element;
              }}
              style={{ display: "contents" }}
              prop:disabled={Boolean(props.disabled) || props.cameraActive === false}
              prop:readSignal={props.readSignal ?? props.attachmentReads?.readSignal}
              prop:onCapture={(file: File) => {
                if (!props.disabled) {
                  appendChatAttachmentFiles([file], props);
                }
              }}
              prop:onNativeCapture={openInput("camera")}
              prop:onUpload={openInput("photo")}
            />
            <For each={["file", "photo", "camera", "media", "camera-video"] as const}>
              {(kind) => {
                const capture = kind === "camera" || kind === "camera-video";
                let captureScope: { signal?: AbortSignal } | undefined;
                const readSignal = () => props.readSignal ?? props.attachmentReads?.readSignal;
                const disabled = () =>
                  props.disabled ||
                  (capture && props.cameraActive === false) ||
                  (kind === "camera-video" && (props.imagesOnly || !useNativeAttachmentCapture()));
                return (
                  <input
                    ref={(element) => {
                      inputs[kind] = element;
                    }}
                    type="file"
                    tabindex="-1"
                    aria-hidden="true"
                    accept={
                      kind === "camera-video"
                        ? "video/*"
                        : props.imagesOnly || kind === "photo" || kind === "camera"
                          ? "image/*"
                          : kind === "media"
                            ? "image/*,video/*"
                            : undefined
                    }
                    multiple={!capture}
                    capture={capture ? "environment" : undefined}
                    class={[`agent-chat__${kind}-input`]}
                    disabled={disabled()}
                    onClick={(event) => {
                      if (!capture) {
                        return;
                      }
                      const signal = readSignal();
                      if (disabled() || signal?.aborted || !event.currentTarget.isConnected) {
                        captureScope = undefined;
                        event.preventDefault();
                        return;
                      }
                      // Native capture can outlive the draft that opened it, before file reading begins.
                      captureScope = { signal };
                    }}
                    onCancel={() => {
                      captureScope = undefined;
                    }}
                    onChange={(event) => {
                      const current =
                        !capture ||
                        (captureScope &&
                          captureScope.signal === readSignal() &&
                          !captureScope.signal?.aborted);
                      captureScope = undefined;
                      if (current && !disabled() && event.currentTarget.isConnected) {
                        const input = event.currentTarget;
                        const files = [...(input.files ?? [])];
                        input.value = "";
                        appendChatAttachmentFiles(files, props);
                      } else {
                        event.currentTarget.value = "";
                      }
                    }}
                  />
                );
              }}
            </For>
          </>
        );
      }}
    </Show>
  );
}
