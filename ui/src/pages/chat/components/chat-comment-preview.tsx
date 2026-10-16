import type { JSX } from "@solidjs/web";
import { createEffect, onCleanup, Show, untrack, useContext } from "solid-js";
import { observeScrollState } from "../../../components/scroll-state-observer.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { AttachmentPreviewChip } from "./chat-attachment-preview-chip.tsx";
import type { CommentPreview } from "./chat-comment-preview.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

function scrollRef() {
  let element: HTMLElement | undefined;
  let observation: ReturnType<typeof observeScrollState> | undefined;
  const presented = useContext(ContentPresentation);
  const connect = (active: boolean) => {
    observation?.disconnect();
    observation = undefined;
    if (!active || !element) {
      return;
    }
    const target = element;
    observation = observeScrollState(target, (state) => {
      for (const key of ["scrollable", "atStart", "atEnd"] as const) {
        target.dataset[key] = String(state[key]);
      }
    });
  };
  createEffect(presented, connect);
  onCleanup(() => observation?.disconnect());
  return (value: HTMLElement) => {
    element = value;
    connect(untrack(presented));
  };
}

export function CommentPreviewRow(props: { comment: CommentPreview; children?: JSX.Element }) {
  const ref = scrollRef();
  return (
    <li class="chat-comment-preview__item">
      <div class="chat-comment-preview__body">
        <span class="muted">{t("chat.messages.annotationSelectedText")}</span>
        <div class="chat-comment-preview__text chat-comment-preview__text--selection">
          {props.comment.text}
        </div>
        <Show when={props.comment.comment}>
          <span class="muted">{t("chat.messages.annotationUserComment")}</span>
          <div
            class="chat-comment-preview__text chat-comment-preview__text--comment"
            tabindex={0}
            role="region"
            aria-label={t("chat.messages.annotationUserComment")}
            ref={ref}
          >
            {props.comment.comment}
          </div>
        </Show>
      </div>
      {props.children}
    </li>
  );
}

type ChipProps = {
  count: number;
  children?: JSX.Element;
  onReveal?: () => void;
  removal?: { onRemove: (event: Event) => void; disabled: boolean };
  elementRef?: (element: Element | undefined) => void;
};

export function CommentPreviewChip(props: ChipProps) {
  const ref = scrollRef();
  return (
    <openclaw-tooltip
      class={
        props.removal
          ? "chat-comment-preview chat-comment-preview--editable"
          : "chat-comment-preview"
      }
      prop:placement="top-start"
      prop:autoSize={true}
      prop:describe={false}
      prop:openOnClick={true}
      prop:hoverDismissDelay={props.removal ? 200 : undefined}
    >
      <AttachmentPreviewChip
        label={t(
          props.count === 1 ? "chat.messages.annotationCount" : "chat.messages.annotationsCount",
          { count: String(props.count) },
        )}
        icon={<Icon name="messageSquare" />}
        onReveal={props.onReveal}
        onClick={props.onReveal}
        elementRef={props.elementRef}
        removal={
          props.removal
            ? { ...props.removal, label: t("chat.messages.removeAnnotations") }
            : undefined
        }
      />
      <div
        slot="content"
        class="chat-comment-preview__scroll"
        tabindex={0}
        role="region"
        aria-label={t("chat.messages.annotations")}
        ref={ref}
      >
        {props.children}
      </div>
    </openclaw-tooltip>
  );
}
