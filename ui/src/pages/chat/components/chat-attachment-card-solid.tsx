import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { attachmentAdmissionRef } from "./chat-attachment-admission-ref.ts";
import {
  openAttachmentCardFromClick,
  prepareAttachmentCardHeader,
  type AttachmentCardHeaderOptions,
} from "./chat-attachment-card.ts";
import { attachmentContextCopyRef } from "./chat-attachment-context-copy.ts";
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
  const ref = attachmentAdmissionRef(() => props.elementRef);
  const copyRef = attachmentContextCopyRef(() => ({
    name: props.label,
    href: props.onDownload || props.downloadPending ? undefined : props.downloadHref,
  }));
  return (
    <div
      ref={[ref, copyRef]}
      onFocusIn={() => props.onFocus?.()}
      class="chat-assistant-attachment-card chat-assistant-attachment-card--compact"
      data-openable={props.onExpand ? "" : undefined}
      onClick={(event) => openAttachmentCardFromClick(event, props.onExpand)}
    >
      <AttachmentCardHeader {...props} visualMode="large-placeholder" />
    </div>
  );
}

export function AttachmentStateCard(
  props: AttachmentCardHeaderOptions & {
    imagePreview: boolean;
    children?: JSX.Element;
    previewRatio?: string;
    error?: string;
    onRetry?: () => void;
  },
) {
  const copyRef = attachmentContextCopyRef(() => ({
    name: props.label,
    href: props.onDownload || props.downloadPending ? undefined : props.downloadHref,
  }));
  return (
    <div
      ref={copyRef}
      class={[
        "chat-assistant-attachment-card",
        `chat-assistant-attachment-card--${props.kind}`,
        "sidebar-attachment-preview__state-card",
      ]}
      aria-busy={props.downloadPending ? "true" : undefined}
    >
      <AttachmentCardHeader {...props} visualMode="preview-with-favicon" />
      <div
        class="sidebar-attachment-preview__state"
        style={{ "--preview-ratio": props.previewRatio }}
      >
        <Show when={props.downloadPending || props.imagePreview}>
          <AttachmentPreviewSkeleton />
        </Show>
        <Show when={props.imagePreview && props.downloadHref} keyed>
          {(src) => (
            <img
              class="sidebar-attachment-preview__image"
              src={src}
              alt={props.label}
              onLoad={(event) => {
                event.currentTarget.dataset.preview = "ready";
              }}
              onError={(event) => {
                event.currentTarget.dataset.preview = "error";
              }}
            />
          )}
        </Show>
        <Show when={!props.downloadPending}>
          <div class="sidebar-attachment-preview__unavailable">
            {t("chat.attachments.previewUnavailable")}
            <Show when={props.error}>{(error) => <span>{error()}</span>}</Show>
            <Show when={props.onRetry}>
              {(retry) => (
                <button class="btn btn--sm" type="button" onClick={() => retry()()}>
                  {t("common.retry")}
                </button>
              )}
            </Show>
          </div>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

export function AttachmentCardHeader(
  props: AttachmentCardHeaderOptions & { expandRef?: (element: HTMLButtonElement) => void },
) {
  const view = createMemo(() => prepareAttachmentCardHeader(props, t));
  return (
    <div
      class={[
        "chat-assistant-attachment-card__header",
        { "chat-assistant-attachment-card__header--preview": view().compactPreview },
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
            { "chat-assistant-attachment-card__details--preview": view().compactPreview },
          ]}
        >
          <span
            class={["chat-assistant-attachment-card__title", { skeleton: props.loading }]}
            title={props.label}
          >
            {props.label}
          </span>
          {view().compactPreview ? (
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
        {props.voiceNote && !view().compactPreview ? (
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
                "chat-assistant-attachment-card__expand--icon": view().compactPreview,
                "chat-assistant-attachment-card__action--labeled": !view().compactPreview,
              },
            ]}
            ref={props.expandRef}
            aria-label={view().expandLabel}
            title={view().expandLabel}
            onClick={() => props.onExpand?.()}
          >
            {view().compactPreview ? (
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
