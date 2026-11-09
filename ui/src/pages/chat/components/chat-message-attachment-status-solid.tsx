import type { JSX } from "@solidjs/web";
import { For, Repeat, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { attachmentContextCopyRef } from "./chat-attachment-context-copy.ts";
import { AttachmentFileIcon } from "./chat-attachment-file-icon-solid.tsx";
import { omittedMediaReason } from "./chat-message-media.ts";

registerEnglishCatalog(registerChatComposerEnglish);

type OmittedMediaItem = Extract<MessageContentItem, { type: "omitted_media" }>;

export function OmittedMedia(props: { items: OmittedMediaItem[] }): JSX.Element {
  return (
    <For each={props.items} keyed={(item) => item}>
      {(item) => (
        <AssistantAttachmentStatusCard
          label={t("chat.attachments.image")}
          badge={t("chat.attachments.history")}
          reason={omittedMediaReason(item().media.sizeBytes)}
        />
      )}
    </For>
  );
}

export type AssistantAttachmentStatusCardProps = {
  label: string;
  mimeType?: string;
  badge: string;
  reason?: string;
  onRetry?: () => void;
  onOpen?: () => void;
  onFindWorkspaceFile?: () => void;
  onAllow?: () => void;
  path?: string;
};

export function AssistantAttachmentStatusCard(
  props: AssistantAttachmentStatusCardProps,
): JSX.Element {
  const copyRef = attachmentContextCopyRef(() => ({ name: props.label }));
  const unavailable = () => props.reason !== undefined;
  const action = () => props.onAllow ?? props.onRetry ?? props.onFindWorkspaceFile ?? props.onOpen;
  const statusClass = () =>
    !unavailable()
      ? "chat-assistant-attachment-card--checking"
      : props.onRetry || props.onAllow || props.onFindWorkspaceFile || props.onOpen
        ? "chat-assistant-attachment-card--recoverable"
        : "chat-assistant-attachment-card--definitive";
  return (
    <div
      ref={copyRef}
      class={[
        "chat-assistant-attachment-card",
        "chat-assistant-attachment-card--blocked",
        statusClass(),
      ]}
      aria-busy={unavailable() ? undefined : "true"}
    >
      <div class="chat-assistant-attachment-card__header">
        <div class="chat-assistant-attachment-card__identity">
          <AttachmentFileIcon
            filename={props.label}
            mimeType={props.mimeType}
            mode="preview-with-favicon"
            unavailable={unavailable()}
          />
          <span class="chat-assistant-attachment-card__details">
            <span
              class="chat-assistant-attachment-card__title"
              title={props.path ?? props.label}
              tabindex={props.path ? 0 : undefined}
            >
              {props.label}
            </span>
            <span
              class={[
                "chat-assistant-attachment-card__meta",
                "chat-assistant-attachment-card__status-meta",
                { skeleton: !unavailable(), "skeleton-line": !unavailable() },
              ]}
              aria-hidden={unavailable() ? undefined : "true"}
            >
              <span class="chat-assistant-attachment-card__status-badge">{props.badge}</span>
              <Show when={props.reason}>
                {" "}
                <span class="chat-assistant-attachment-card__status-separator" aria-hidden="true">
                  ·
                </span>{" "}
                <span class="chat-assistant-attachment-card__status-reason">{props.reason}</span>
              </Show>
            </span>
          </span>
        </div>
        <Show
          when={action()}
          fallback={
            <Show when={!unavailable()}>
              <span
                class="chat-assistant-attachment-card__actions chat-assistant-attachment-card__actions--loading"
                aria-hidden="true"
                data-label={t("chat.attachments.open")}
              >
                <span
                  class="chat-assistant-attachment-card__action-skeleton skeleton"
                  aria-hidden="true"
                />
              </span>
            </Show>
          }
        >
          <button
            class={[
              "chat-assistant-attachment-card__action chat-assistant-attachment-card__action--labeled",
              {
                "chat-assistant-attachment-card__allow": Boolean(props.onAllow),
                "chat-assistant-attachment-card__retry": !props.onAllow && Boolean(props.onRetry),
              },
            ]}
            type="button"
            aria-label={
              !props.onAllow && !props.onRetry && props.onFindWorkspaceFile
                ? t("chat.attachments.findInFilesFor", { name: props.label })
                : undefined
            }
            onClick={() => action()?.()}
          >
            <Show when={!props.onAllow && Boolean(props.onRetry)}>
              <Icon name="refresh" />
            </Show>
            {props.onAllow
              ? t("chat.attachments.allowImage")
              : props.onRetry
                ? t("common.retry")
                : props.onFindWorkspaceFile
                  ? t("chat.attachments.findInFiles")
                  : t("chat.attachments.openOriginal")}
          </button>
        </Show>
      </div>
      <Show when={props.onOpen && (props.onRetry || props.onAllow)}>
        <button
          type="button"
          class="chat-assistant-attachment-card__action chat-assistant-attachment-card__action--labeled chat-assistant-attachment-card__original"
          onClick={() => props.onOpen?.()}
        >
          {t("chat.attachments.openOriginal")}
        </button>
      </Show>
    </div>
  );
}

export function PairingQrNotices(props: { count: number }) {
  return (
    <Show when={props.count > 0}>
      <div class="chat-pairing-qr-notices">
        <Repeat count={props.count}>
          {() => (
            <div class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked chat-pairing-qr-expired">
              <span class="chat-pairing-qr-expired__icon" aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <div class="chat-pairing-qr-expired__content">
                <div class="chat-pairing-qr-expired__heading">
                  <span class="chat-pairing-qr-expired__title">
                    {t("chat.pairingQrExpired.title")}
                  </span>
                  <span class="chat-pairing-qr-expired__badge">
                    {t("chat.pairingQrExpired.badge")}
                  </span>
                </div>
                <div class="chat-assistant-attachment-card__reason">
                  {t("chat.pairingQrExpired.reason")}
                </div>
              </div>
            </div>
          )}
        </Repeat>
      </div>
    </Show>
  );
}
