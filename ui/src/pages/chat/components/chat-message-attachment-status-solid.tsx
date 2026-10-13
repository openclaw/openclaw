import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import { renderAttachmentFileIcon } from "./chat-attachment-file-icon.ts";
import { omittedMediaReason } from "./chat-message-media.ts";

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
  onAllow?: () => void;
  path?: string;
};

export function AssistantAttachmentStatusCard(
  props: AssistantAttachmentStatusCardProps,
): JSX.Element {
  const unavailable = () => props.reason !== undefined;
  const statusClass = () =>
    !unavailable()
      ? "chat-assistant-attachment-card--checking"
      : props.onRetry || props.onAllow
        ? "chat-assistant-attachment-card--recoverable"
        : "chat-assistant-attachment-card--definitive";
  return (
    <div
      class={[
        "chat-assistant-attachment-card",
        "chat-assistant-attachment-card--blocked",
        statusClass(),
      ]}
      aria-busy={unavailable() ? undefined : "true"}
    >
      <div class="chat-assistant-attachment-card__header">
        <div class="chat-assistant-attachment-card__identity">
          <LitContent
            value={renderAttachmentFileIcon({
              filename: props.label,
              mimeType: props.mimeType,
              mode: "large-placeholder",
              unavailable: unavailable(),
            })}
          />
          <span class="chat-assistant-attachment-card__details">
            <span
              class={[
                "chat-assistant-attachment-card__title",
                { "chat-assistant-attachment-card__title--unavailable": unavailable() },
              ]}
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
          when={props.onAllow}
          fallback={
            <Show
              when={props.onRetry}
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
                class="chat-assistant-attachment-card__action chat-assistant-attachment-card__action--labeled chat-assistant-attachment-card__retry"
                type="button"
                onClick={() => props.onRetry?.()}
              >
                <Icon name="refresh" />
                {t("common.retry")}
              </button>
            </Show>
          }
        >
          <button
            class="chat-assistant-attachment-card__action chat-assistant-attachment-card__action--labeled"
            type="button"
            onClick={() => props.onAllow?.()}
          >
            {t("chat.attachments.allowImage")}
          </button>
        </Show>
      </div>
    </div>
  );
}
