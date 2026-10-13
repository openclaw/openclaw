import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  openAttachmentCardFromClick,
  type AttachmentCardHeaderOptions,
} from "./chat-attachment-card.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import { resolveAttachmentFileIcon } from "./chat-attachment-file-icon.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

export function CompactAttachmentCard(props: AttachmentCardHeaderOptions) {
  return (
    <div
      class="chat-assistant-attachment-card chat-assistant-attachment-card--compact"
      data-openable={props.onExpand ? "" : undefined}
      onClick={(event) => openAttachmentCardFromClick(event, props.onExpand)}
    >
      <AttachmentCardHeader {...props} visualMode="large-placeholder" />
    </div>
  );
}

export function AttachmentCardHeader(props: AttachmentCardHeaderOptions) {
  const compactPreview = () => props.visualMode === "preview-with-favicon";
  const formattedSize = () =>
    props.sizeBytes === undefined ? undefined : formatBytes(props.sizeBytes);
  const typeLabel = () => {
    if (props.kind === "audio") {
      return t("chat.attachments.audio");
    }
    if (props.kind === "video") {
      return t("chat.attachments.video");
    }
    if (props.kind === "image") {
      return t("chat.attachments.attachedFile");
    }
    return resolveAttachmentFileIcon(props.label, props.mimeType).extensionLabel;
  };
  const downloadTitle = () => t("chat.mediaPlayer.download", { filename: props.label });
  const expandLabel = () =>
    props.expandLabel ?? t("chat.attachments.expand", { filename: props.label });
  const downloadClass = () => [
    "chat-assistant-attachment-card__action chat-assistant-attachment-card__download chat-assistant-attachment-card__download--ghost",
    {
      "chat-assistant-attachment-card__download--secondary": props.onExpand !== undefined,
      skeleton: props.loading,
    },
  ];
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
            formattedSize() ? (
              <>
                <span class="chat-assistant-attachment-card__separator" aria-hidden="true">
                  ·
                </span>
                <span class={["chat-assistant-attachment-card__meta", { skeleton: props.loading }]}>
                  {formattedSize()}
                </span>
              </>
            ) : null
          ) : (
            <span class="chat-assistant-attachment-card__meta">
              {[typeLabel(), formattedSize()].filter(Boolean).join(" · ")}
            </span>
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
            class={downloadClass()}
            disabled={props.downloadPending}
            aria-label={downloadTitle()}
            title={downloadTitle()}
            onClick={() => props.onDownload?.()}
          >
            <Icon name="download" />
          </button>
        ) : props.downloadHref || props.downloadPending ? (
          <a
            class={downloadClass()}
            href={props.downloadPending ? undefined : props.downloadHref}
            aria-disabled={props.downloadPending ? "true" : undefined}
            tabindex={props.downloadPending && props.downloadPendingFocusable ? 0 : undefined}
            role="link"
            download={props.label}
            target="_blank"
            rel="noreferrer"
            aria-label={downloadTitle()}
            title={downloadTitle()}
          >
            <Icon name="download" />
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
            aria-label={expandLabel()}
            title={expandLabel()}
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
