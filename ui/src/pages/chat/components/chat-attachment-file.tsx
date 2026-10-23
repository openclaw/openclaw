import type { JSX } from "@solidjs/web";
import { createMemo, Loading, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { getChatAttachmentVideoPosterUrl } from "../attachment-payload-store.ts";
import { attachmentContextCopyRef } from "./chat-attachment-context-copy.ts";
import { resolveAttachmentFileIcon } from "./chat-attachment-file-icon.ts";

export function AttachmentRemove(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  buttonRef?: (element: HTMLButtonElement) => void;
  class?: string;
}) {
  return (
    <openclaw-tooltip prop:content={props.label}>
      <button
        ref={[props.buttonRef]}
        class={props.class ?? "chat-attachment-remove"}
        type="button"
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => props.onClick()}
      >
        <Icon name="x" />
      </button>
    </openclaw-tooltip>
  );
}

type VideoPreparation = { state: "offer" | "compressing" | "error"; progress?: number };

function AttachmentVideoPreview(props: {
  attachment: ChatAttachment;
  preparation?: VideoPreparation;
}) {
  const poster = createMemo(
    async () => (await getChatAttachmentVideoPosterUrl(props.attachment)) ?? undefined,
  );
  return (
    <span class="chat-attachment-file__preview" aria-hidden="true">
      <Show
        when={props.preparation}
        fallback={
          <Loading on={props.attachment} fallback={<Icon name="play" />}>
            <Show when={poster()} fallback={<Icon name="play" />}>
              <img src={poster()} alt="" />
              <span class="chat-attachment-video__play">
                <Icon name="play" />
              </span>
            </Show>
          </Loading>
        }
      >
        {(preparation) => (
          <>
            <span class="chat-attachment-video__placeholder">
              {preparation().state === "compressing" ? (
                <svg class="chat-attachment-compression-progress" viewBox="0 0 32 32">
                  <circle
                    class="chat-attachment-compression-progress__track"
                    cx="16"
                    cy="16"
                    r="13"
                  />
                  <circle
                    cx="16"
                    cy="16"
                    r="13"
                    pathLength="100"
                    stroke-dasharray={`${(preparation().progress ?? 0) * 100} 100`}
                  />
                </svg>
              ) : (
                <Icon name="play" />
              )}
            </span>
            <Show when={preparation().state !== "compressing"}>
              <span
                class={[
                  "chat-attachment-video__play",
                  {
                    "chat-attachment-video__play--warning": preparation().state === "offer",
                    "chat-attachment-video__play--error": preparation().state === "error",
                  },
                ]}
              >
                <Icon name="alertTriangle" />
              </span>
            </Show>
          </>
        )}
      </Show>
    </span>
  );
}

export function CompactAttachmentFile(props: {
  attachment: ChatAttachment;
  label?: string;
  metadata?: JSX.Element;
  videoPreparation?: VideoPreparation;
  onOpen?: () => void;
}) {
  let openButton: HTMLButtonElement | undefined;
  const icon = createMemo(() =>
    resolveAttachmentFileIcon(props.attachment.fileName ?? "attachment", props.attachment.mimeType),
  );
  const name = () => props.label ?? props.attachment.fileName ?? t("chat.attachments.attachedFile");
  const copyRef = attachmentContextCopyRef(() => ({ name: name() }));
  const content = () => (
    <div
      ref={copyRef}
      class={["chat-attachment-file", { "chat-attachment-file--video": icon().family === "video" }]}
      onClick={(event: MouseEvent) => {
        if (event.target instanceof Element && !event.target.closest("button")) {
          props.onOpen?.();
        }
      }}
    >
      {icon().family === "video" ? (
        <AttachmentVideoPreview
          attachment={props.attachment}
          preparation={props.videoPreparation}
        />
      ) : (
        <span class="chat-attachment-file__icon" data-family={icon().family}>
          <Icon name={icon().family === "audio" ? "music" : "fileText"} />
        </span>
      )}
      <span class="chat-attachment-file__body">
        {props.onOpen ? (
          <button
            ref={(element) => (openButton = element)}
            class="chat-attachment-file__name chat-attachment-file__open"
            type="button"
            title={name()}
            onClick={() => props.onOpen?.()}
          >
            {name()}
          </button>
        ) : (
          <span class="chat-attachment-file__name">{name()}</span>
        )}
        {props.metadata ?? (
          <span class="chat-attachment-file__type">
            {icon().extensionLabel}
            {icon().family === "video" && props.attachment.sizeBytes !== undefined
              ? ` · ${formatBytes(props.attachment.sizeBytes)}`
              : ""}
          </span>
        )}
      </span>
    </div>
  );
  return (
    <Show
      when={props.label !== undefined}
      fallback={
        <openclaw-tooltip
          prop:content={name()}
          prop:descriptionTarget={props.onOpen ? () => openButton ?? null : undefined}
        >
          {content()}
        </openclaw-tooltip>
      }
    >
      {content()}
    </Show>
  );
}
