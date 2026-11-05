import type { JSX } from "@solidjs/web";
import { Show, useContext } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { createScrollStateRef } from "../../../lib/reactive/scroll-state.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { AttachmentPreviewChip } from "./chat-attachment-preview-chip.tsx";
import type { CommentPreview } from "./chat-comment-preview.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

function scrollRef() {
  const presented = useContext(ContentPresentation);
  return createScrollStateRef(
    (element, state) => {
      for (const key of ["scrollable", "atStart", "atEnd"] as const) {
        element.dataset[key] = String(state[key]);
      }
    },
    { presented },
  );
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

export function CommentPreviewChip(props: {
  count: number;
  children?: JSX.Element;
  onReveal?: () => void;
  removal?: { onRemove: (event: Event) => void; disabled: boolean };
  elementRef?: (element: Element | undefined) => void;
  previewRef?: (element: HTMLElement) => void;
  triggerRef?: (element: HTMLButtonElement) => void;
}) {
  const ref = scrollRef();
  let trigger: HTMLButtonElement | undefined;
  // Wide previews need the full inline area to flip without covering their trigger.
  return (
    <openclaw-tooltip
      ref={props.previewRef}
      class={["chat-comment-preview", { "chat-comment-preview--editable": Boolean(props.removal) }]}
      prop:placement="top"
      prop:autoSize={true}
      prop:describe={false}
      prop:descriptionTarget={props.removal ? () => trigger ?? null : undefined}
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
        triggerRef={[(element) => (trigger = element), props.triggerRef]}
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
