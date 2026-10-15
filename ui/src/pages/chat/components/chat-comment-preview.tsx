import type { JSX } from "@solidjs/web";
import { For, Show, onCleanup } from "solid-js";
import { observeScrollState } from "../../../components/scroll-state-observer.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { LitContent, solidContent } from "../../../lit/solid-content.tsx";
import { AttachmentPreviewChip } from "./chat-attachment-preview-chip.tsx";
import type { CommentPreview } from "./chat-comment-preview.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

function scrollRef() {
  let observation: ReturnType<typeof observeScrollState> | undefined;
  onCleanup(() => observation?.disconnect());
  return (element: HTMLElement) => {
    observation?.disconnect();
    observation = observeScrollState(element, (state) => {
      for (const key of ["scrollable", "atStart", "atEnd"] as const) {
        element.dataset[key] = String(state[key]);
      }
    });
  };
}

export function CommentPreviewRow(props: { comment: CommentPreview; children?: JSX.Element }) {
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
            ref={scrollRef()}
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
        ref={scrollRef()}
      >
        {props.children}
      </div>
    </openclaw-tooltip>
  );
}

function LegacyCommentRows(props: {
  rows: ReadonlyArray<{ comment: CommentPreview; actions?: unknown }>;
}) {
  return (
    <ol class="chat-comment-preview__list" role="list">
      <For each={props.rows} keyed={false}>
        {(row) => (
          <CommentPreviewRow comment={row().comment}>
            <LitContent value={row().actions} />
          </CommentPreviewRow>
        )}
      </For>
    </ol>
  );
}

function LegacyCommentChip(props: ChipProps & { content: unknown }) {
  return (
    <CommentPreviewChip
      count={props.count}
      onReveal={props.onReveal}
      removal={props.removal}
      elementRef={props.elementRef}
    >
      <LitContent value={props.content} />
    </CommentPreviewChip>
  );
}

export function renderCommentPreviewRows(
  rows: ReadonlyArray<{ comment: CommentPreview; actions?: unknown }>,
) {
  return solidContent(LegacyCommentRows, { rows });
}

export function renderCommentPreviewChip(
  count: number,
  content: unknown,
  onReveal?: () => void,
  removal?: ChipProps["removal"],
  elementRef?: ChipProps["elementRef"],
) {
  return solidContent(LegacyCommentChip, { count, content, onReveal, removal, elementRef });
}
