import { createEffect, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  openAttachmentCardFromClick,
  prepareAttachmentCardHeader,
  type AttachmentCardHeaderOptions,
} from "./chat-attachment-card.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

export function AttachmentPreviewSkeleton() {
  return (
    <div class="sidebar-attachment-preview__loading" role="status" aria-label={t("common.loading")}>
      <div class="skeleton skeleton-line" aria-hidden="true" />
      <div class="skeleton skeleton-line skeleton-line--long" aria-hidden="true" />
      <div class="skeleton skeleton-line skeleton-line--medium" aria-hidden="true" />
    </div>
  );
}

export function CompactAttachmentCard(
  props: AttachmentCardHeaderOptions & {
    elementRef?: (element: Element | undefined) => void;
    onFocus?: () => void;
  },
) {
  let element!: HTMLDivElement;
  createEffect(
    () => props.elementRef,
    (ref) => {
      ref?.(element);
      return () => ref?.(undefined);
    },
  );
  return (
    <div
      ref={(node) => {
        element = node;
      }}
      onFocusIn={() => props.onFocus?.()}
      class="chat-assistant-attachment-card chat-assistant-attachment-card--compact"
      data-openable={props.onExpand ? "" : undefined}
      onClick={(event) => openAttachmentCardFromClick(event, props.onExpand)}
    >
      <AttachmentCardHeader {...props} visualMode="large-placeholder" />
    </div>
  );
}

export function AttachmentCardHeader(props: AttachmentCardHeaderOptions) {
  const view = createMemo(() => prepareAttachmentCardHeader(props, t));
  const compactPreview = () => view().compactPreview;
  return (
    <div
      class={[
        "chat-assistant-attachment-card__header",
        { "chat-assistant-attachment-card__header--preview": compactPreview() },
      ]}
    >
      <div class="chat-assistant-attachment-card__identity">
        <AttachmentFileIcon
          filename={props.label}
          mimeType={props.mimeType}
          mode={props.visualMode ?? "large-placeholder"}
          loading={props.loading}
        />
        <span
          class={[
            "chat-assistant-attachment-card__details",
            { "chat-assistant-attachment-card__details--preview": compactPreview() },
          ]}
        >
          <span
            class={["chat-assistant-attachment-card__title", { skeleton: props.loading }]}
            title={props.label}
          >
            {props.label}
          </span>
          {compactPreview() ? (
            view().formattedSize ? (
              <>
                <span class="chat-assistant-attachment-card__separator" aria-hidden="true">
                  ·
                </span>
                <span class={["chat-assistant-attachment-card__meta", { skeleton: props.loading }]}>
                  {view().formattedSize}
                </span>
              </>
            ) : null
          ) : (
            <span class="chat-assistant-attachment-card__meta">{view().metadata}</span>
          )}
        </span>
      </div>
      <span class="chat-assistant-attachment-card__actions">
        {props.voiceNote && !compactPreview() ? (
          <span class="chat-assistant-attachment-badge">{t("chat.messages.voiceNote")}</span>
        ) : null}
        {props.onDownload ? (
          <button
            type="button"
            class={view().downloadClass}
            disabled={props.downloadPending}
            aria-label={view().downloadTitle}
            title={view().downloadTitle}
            onClick={() => props.onDownload?.()}
          >
            <Icon name="download" />
            {view().downloadLabel ? <span>{view().downloadLabel}</span> : null}
          </button>
        ) : props.downloadHref || props.downloadPending ? (
          <a
            class={view().downloadClass}
            href={props.downloadPending ? undefined : props.downloadHref}
            aria-disabled={props.downloadPending ? "true" : undefined}
            tabindex={props.downloadPending && props.downloadPendingFocusable ? 0 : undefined}
            role="link"
            download={props.label}
            target="_blank"
            rel="noreferrer"
            aria-label={view().downloadTitle}
            title={view().downloadTitle}
          >
            <Icon name="download" />
            {view().downloadLabel ? <span>{view().downloadLabel}</span> : null}
          </a>
        ) : null}
        {props.onExpand !== undefined ? (
          <button
            type="button"
            class={[
              "chat-assistant-attachment-card__action chat-assistant-attachment-card__expand",
              {
                "chat-assistant-attachment-card__expand--icon": compactPreview(),
                "chat-assistant-attachment-card__action--labeled": !compactPreview(),
              },
            ]}
            aria-label={view().expandLabel}
            title={view().expandLabel}
            onClick={() => props.onExpand?.()}
          >
            {compactPreview() ? (
              <Icon name="chevronsUpDown" />
            ) : (
              <span>{t("chat.attachments.open")}</span>
            )}
          </button>
        ) : null}
      </span>
    </div>
  );
}
