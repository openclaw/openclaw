import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { getChatAttachmentVideoPosterUrl } from "../attachment-payload-store.ts";
import { resolveAttachmentFileIcon } from "./chat-attachment-file-icon.ts";

export function AttachmentRemove(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  class?: string;
}) {
  return (
    <openclaw-tooltip prop:content={props.label}>
      <button
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

function AttachmentVideoPreview(props: { attachment: ChatAttachment }) {
  const [poster, setPoster] = createSignal<string | undefined>(undefined, { ownedWrite: true });
  const source = createMemo(
    () => ({ pending: getChatAttachmentVideoPosterUrl(props.attachment) }),
    { equals: (before, next) => before.pending === next.pending },
  );
  createEffect(source, ({ pending }) => {
    let active = true;
    setPoster(undefined);
    void pending?.then((src) => {
      if (active) {
        setPoster(src ?? undefined);
      }
    });
    return () => {
      active = false;
    };
  });
  return (
    <span class="chat-attachment-file__preview" aria-hidden="true">
      {poster() ? (
        <>
          <img src={poster()} alt="" />
          <span class="chat-attachment-video__play">
            <Icon name="play" />
          </span>
        </>
      ) : (
        <Icon name="play" />
      )}
    </span>
  );
}

export function CompactAttachmentFile(props: {
  attachment: ChatAttachment;
  label?: string;
  metadata?: JSX.Element;
  onOpen?: () => void;
}) {
  const icon = createMemo(() =>
    resolveAttachmentFileIcon(props.attachment.fileName ?? "attachment", props.attachment.mimeType),
  );
  const name = () => props.label ?? props.attachment.fileName ?? t("chat.attachments.attachedFile");
  const content = () => (
    <div
      class={["chat-attachment-file", { "chat-attachment-file--video": icon().family === "video" }]}
      onClick={(event: MouseEvent) => {
        if (event.target instanceof Element && !event.target.closest("button")) {
          props.onOpen?.();
        }
      }}
    >
      {icon().family === "video" ? (
        <AttachmentVideoPreview attachment={props.attachment} />
      ) : (
        <span class="chat-attachment-file__icon" data-family={icon().family}>
          <Icon name={icon().family === "audio" ? "music" : "fileText"} />
        </span>
      )}
      <span class="chat-attachment-file__body">
        {props.onOpen ? (
          <button
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
        {props.metadata ?? <span class="chat-attachment-file__type">{icon().extensionLabel}</span>}
      </span>
    </div>
  );
  return (
    <Show
      when={props.label !== undefined}
      fallback={<openclaw-tooltip prop:content={name()}>{content()}</openclaw-tooltip>}
    >
      {content()}
    </Show>
  );
}
