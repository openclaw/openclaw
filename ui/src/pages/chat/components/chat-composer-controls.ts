// Chat-owned composer queue, status, context, and run controls.
import { html, nothing } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import type { CompactionStatus, FallbackStatus } from "../../../ui/app-tool-stream.ts";
import {
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { CHAT_RUN_STATUS_TOAST_DURATION_MS, type ChatRunUiStatus } from "../run-lifecycle.ts";

const COMPACTION_TOAST_DURATION_MS = 5000;
const FALLBACK_TOAST_DURATION_MS = 8000;
const CONTEXT_NOTICE_RATIO = 0.85;
const CONTEXT_COMPACT_RATIO = 0.9;
export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";

export type ChatAttachmentControlsProps = {
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
};

export type ChatQueueProps = {
  queue: ChatQueueItem[];
  canAbort?: boolean;
  onQueueRetry?: (id: string) => void;
  onQueueSteer?: (id: string) => void;
  onQueueRemove: (id: string) => void;
};

function sendStateLabel(item: ChatQueueItem): string | null {
  switch (item.sendState) {
    case "waiting-model":
      return "Waiting for model";
    case "sending":
      return "Sending";
    case "waiting-reconnect":
      return "Waiting for reconnect";
    case "failed":
      return "Failed";
    default:
      return null;
  }
}

export function renderChatQueue(props: ChatQueueProps) {
  if (!props.queue.length) {
    return nothing;
  }
  return html`
    <div class="chat-queue" role="status" aria-live="polite">
      <div class="chat-queue__title">Queued (${props.queue.length})</div>
      <div class="chat-queue__list">
        ${props.queue.map((item) => {
          const stateLabel = sendStateLabel(item);
          return html`
            <div
              class="chat-queue__item ${item.kind === "steered" ? "chat-queue__item--steered" : ""}"
            >
              <div class="chat-queue__main">
                ${item.kind === "steered"
                  ? html`<span class="chat-queue__badge">Steered</span>`
                  : nothing}
                ${stateLabel ? html`<span class="chat-queue__badge">${stateLabel}</span>` : nothing}
                <div class="chat-queue__text">
                  ${item.text ||
                  (item.attachments?.length ? `Image (${item.attachments.length})` : "")}
                </div>
                ${item.sendError
                  ? html`<div class="chat-queue__error">${item.sendError}</div>`
                  : nothing}
              </div>
              <div class="chat-queue__actions">
                ${item.sendState === "failed" && props.onQueueRetry
                  ? html`
                      <button
                        class="btn chat-queue__retry"
                        type="button"
                        aria-label=${t("chat.queue.retryQueuedMessage")}
                        @click=${() => props.onQueueRetry?.(item.id)}
                      >
                        ${icons.refresh}
                        <span>${t("chat.queue.retry")}</span>
                      </button>
                    `
                  : nothing}
                ${props.canAbort &&
                props.onQueueSteer &&
                item.kind !== "steered" &&
                !item.sendState &&
                !item.localCommandName
                  ? html`
                      <button
                        class="btn chat-queue__steer"
                        type="button"
                        aria-label="Steer queued message"
                        @click=${() => props.onQueueSteer?.(item.id)}
                      >
                        ${icons.cornerDownRight}
                        <span>Steer</span>
                      </button>
                    `
                  : nothing}
                <openclaw-tooltip content="Remove queued message">
                  <button
                    class="btn chat-queue__remove"
                    type="button"
                    aria-label="Remove queued message"
                    @click=${() => props.onQueueRemove(item.id)}
                  >
                    ${icons.x}
                  </button>
                </openclaw-tooltip>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }
  return !/\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i.test(file.name);
}

export function clickComposerFileInput(event: MouseEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target
    .closest(".agent-chat__input")
    ?.querySelector<HTMLInputElement>(".agent-chat__file-input")
    ?.click();
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function chatAttachmentFromFile(file: File, dataUrl: string): ChatAttachment {
  const attachment = {
    id: generateAttachmentId(),
    mimeType: file.type || "application/octet-stream",
    fileName: file.name || undefined,
    sizeBytes: file.size,
  };
  return registerChatAttachmentPayload({ attachment, dataUrl, file });
}

function dataImageClipboardFile(dataUrl: string): { file: File; dataUrl: string } | null {
  const match = /^\s*data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\s*$/i.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1].toLowerCase();
  if (!isSupportedChatAttachmentFile({ name: "pasted-image", type: mimeType })) {
    return null;
  }
  const base64 = match[2].replace(/\s+/g, "");
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9.+-]/gi, "") || "png";
    return {
      file: new File([bytes], `pasted-image.${extension}`, { type: mimeType }),
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
  } catch {
    return null;
  }
}

function isImageAttachment(att: ChatAttachment): boolean {
  return att.mimeType.startsWith("image/");
}

export function handleChatAttachmentPaste(e: ClipboardEvent, props: ChatAttachmentControlsProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }
  const imageItems: DataTransferItem[] = [];
  for (const item of Array.from(items)) {
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }
  if (imageItems.length === 0) {
    const text = e.clipboardData?.getData("text/plain");
    const pasted = text ? dataImageClipboardFile(text) : null;
    if (!pasted) {
      return;
    }
    e.preventDefault();
    props.onAttachmentsChange([
      ...(props.attachments ?? []),
      chatAttachmentFromFile(pasted.file, pasted.dataUrl),
    ]);
    return;
  }
  e.preventDefault();
  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment = chatAttachmentFromFile(file, dataUrl);
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

export function handleChatAttachmentFileSelect(e: Event, props: ChatAttachmentControlsProps) {
  const input = e.target as HTMLInputElement;
  if (!input.files || !props.onAttachmentsChange) {
    return;
  }
  const current = props.attachments ?? [];
  const additions: ChatAttachment[] = [];
  let pending = 0;
  for (const file of input.files) {
    if (!isSupportedChatAttachmentFile(file)) {
      continue;
    }
    pending++;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      additions.push(chatAttachmentFromFile(file, reader.result as string));
      pending--;
      if (pending === 0) {
        props.onAttachmentsChange?.([...current, ...additions]);
      }
    });
    reader.readAsDataURL(file);
  }
  input.value = "";
}

export function handleChatAttachmentDrop(e: DragEvent, props: ChatAttachmentControlsProps) {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files || !props.onAttachmentsChange) {
    return;
  }
  const current = props.attachments ?? [];
  const additions: ChatAttachment[] = [];
  let pending = 0;
  for (const file of files) {
    if (!isSupportedChatAttachmentFile(file)) {
      continue;
    }
    pending++;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      additions.push(chatAttachmentFromFile(file, reader.result as string));
      pending--;
      if (pending === 0) {
        props.onAttachmentsChange?.([...current, ...additions]);
      }
    });
    reader.readAsDataURL(file);
  }
}

export function renderAttachmentPreview(props: ChatAttachmentControlsProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-attachments-preview">
      ${attachments.map(
        (att) => html`
          <div
            class=${[
              "chat-attachment-thumb",
              isImageAttachment(att) ? "" : "chat-attachment-thumb--file",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            ${isImageAttachment(att) && getChatAttachmentPreviewUrl(att)
              ? html`<img src=${getChatAttachmentPreviewUrl(att)!} alt="Attachment preview" />`
              : html`
                  <openclaw-tooltip .content=${att.fileName ?? "Attached file"}>
                    <div class="chat-attachment-file">
                      <span class="chat-attachment-file__icon">${icons.paperclip}</span>
                      <span class="chat-attachment-file__name"
                        >${att.fileName ?? "Attached file"}</span
                      >
                    </div>
                  </openclaw-tooltip>
                `}
            <openclaw-tooltip content="Remove attachment">
              <button
                class="chat-attachment-remove"
                type="button"
                aria-label="Remove attachment"
                @click=${() => {
                  const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                  releaseChatAttachmentPayload(att.id);
                  props.onAttachmentsChange?.(next);
                }}
              >
                &times;
              </button>
            </openclaw-tooltip>
          </div>
        `,
      )}
    </div>
  `;
}

export type ComposerRunStatus =
  | ChatRunUiStatus
  | {
      phase: "in-progress";
      occurredAt?: number | null;
    };

export function renderChatRunStatusIndicator(status: ComposerRunStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  if (status.phase !== "in-progress") {
    const elapsed = Date.now() - status.occurredAt;
    if (elapsed >= CHAT_RUN_STATUS_TOAST_DURATION_MS) {
      return nothing;
    }
  }
  const label =
    status.phase === "in-progress"
      ? "In progress"
      : status.phase === "done"
        ? "Done"
        : "Interrupted";
  const icon =
    status.phase === "in-progress"
      ? icons.loader
      : status.phase === "done"
        ? icons.check
        : icons.stop;
  return html`
    <span
      class="agent-chat__run-status agent-chat__run-status--${status.phase}"
      role="status"
      aria-live="polite"
      aria-label=${`Run status: ${label}`}
    >
      ${icon}<span class="agent-chat__run-status-label">${label}</span>
    </span>
  `;
}

export function renderCompactionIndicator(status: CompactionStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  if (status.phase === "active" || status.phase === "retrying") {
    return html`
      <div
        class="compaction-indicator compaction-indicator--active"
        role="status"
        aria-live="polite"
      >
        ${icons.loader} Compacting context...
      </div>
    `;
  }
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div
          class="compaction-indicator compaction-indicator--complete"
          role="status"
          aria-live="polite"
        >
          ${icons.check} Context compacted
        </div>
      `;
    }
  }
  return nothing;
}

export function renderFallbackIndicator(status: FallbackStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    `Selected: ${status.selected}`,
    phase === "cleared" ? `Active: ${status.selected}` : `Active: ${status.active}`,
    phase === "cleared" && status.previous ? `Previous fallback: ${status.previous}` : null,
    status.reason ? `Reason: ${status.reason}` : null,
    status.attempts.length > 0 ? `Attempts: ${status.attempts.slice(0, 3).join(" | ")}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? `Fallback cleared: ${status.selected}`
      : `Fallback active: ${status.active}`;
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <openclaw-tooltip .content=${details}>
      <div class=${className} role="status" aria-live="polite" aria-label=${details}>
        ${icon} ${message}
      </div>
    </openclaw-tooltip>
  `;
}

export type ContextNoticeOptions = {
  compactBusy?: boolean;
  compactDisabled?: boolean;
  onCompact?: () => void | Promise<void>;
};

function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return null;
  }
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

let cachedThemeNoticeColors: {
  warnHex: string;
  dangerHex: string;
  warnRgb: [number, number, number];
  dangerRgb: [number, number, number];
} | null = null;

function getThemeNoticeColors() {
  if (cachedThemeNoticeColors) {
    return cachedThemeNoticeColors;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const warnHex = rootStyle.getPropertyValue("--warn").trim() || "#f59e0b";
  const dangerHex = rootStyle.getPropertyValue("--danger").trim() || "#ef4444";
  cachedThemeNoticeColors = {
    warnHex,
    dangerHex,
    warnRgb: parseHexRgb(warnHex) ?? [245, 158, 11],
    dangerRgb: parseHexRgb(dangerHex) ?? [239, 68, 68],
  };
  return cachedThemeNoticeColors;
}

export function resetContextNoticeThemeCacheForTest(): void {
  cachedThemeNoticeColors = null;
}

export function getContextNoticeViewModel(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
): {
  pct: number;
  detail: string;
  color: string;
  bg: string;
  warning: boolean;
  compactRecommended: boolean;
} | null {
  if (session?.totalTokensFresh === false) {
    return null;
  }
  const used = session?.totalTokens;
  const limit = session?.contextTokens ?? defaultContextTokens ?? 0;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || !limit) {
    return null;
  }
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  const warning = ratio >= CONTEXT_NOTICE_RATIO;
  if (!warning) {
    return {
      pct,
      detail: `${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
      color: "var(--muted)",
      bg: "color-mix(in srgb, var(--muted) 8%, transparent)",
      warning,
      compactRecommended: false,
    };
  }
  const { warnRgb, dangerRgb } = getThemeNoticeColors();
  const [wr, wg, wb] = warnRgb;
  const [dr, dg, db] = dangerRgb;
  const mix = Math.min(Math.max((ratio - 0.85) / 0.1, 0), 1);
  const r = Math.round(wr + (dr - wr) * mix);
  const g = Math.round(wg + (dg - wg) * mix);
  const b = Math.round(wb + (db - wb) * mix);
  const color = `rgb(${r}, ${g}, ${b})`;
  const bgOpacity = 0.08 + 0.08 * mix;
  const bg = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;
  return {
    pct,
    detail: `${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
    color,
    bg,
    warning,
    compactRecommended: ratio >= CONTEXT_COMPACT_RATIO,
  };
}

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function renderContextNotice(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
  options: ContextNoticeOptions = {},
) {
  const model = getContextNoticeViewModel(session, defaultContextTokens);
  if (!model) {
    return nothing;
  }
  const canRenderCompact = model.compactRecommended && options.onCompact;
  const compactDisabled = options.compactDisabled === true || options.compactBusy === true;
  const summary = `Session context usage: ${model.detail} (${model.pct}%)`;
  const dashOffset = RING_CIRCUMFERENCE * (1 - model.pct / 100);
  return html`
    <div
      class="context-ring ${model.warning ? "context-ring--warning" : ""}"
      role="status"
      aria-label=${summary}
      style="--ctx-color:${model.color};--ctx-bg:${model.bg}"
    >
      <svg class="context-ring__dial" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle class="context-ring__track" cx="8" cy="8" r=${RING_RADIUS} />
        <circle
          class="context-ring__fill"
          cx="8"
          cy="8"
          r=${RING_RADIUS}
          stroke-dasharray=${RING_CIRCUMFERENCE.toFixed(2)}
          stroke-dashoffset=${dashOffset.toFixed(2)}
        />
      </svg>
      <span class="context-ring__pct">${model.pct}%</span>
      ${canRenderCompact
        ? html`
            <button
              class="context-ring__action ${options.compactBusy ? "context-ring__action--busy" : ""}"
              type="button"
              aria-label="Compact recommended session context"
              ?disabled=${compactDisabled}
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                if (compactDisabled) {
                  return;
                }
                void options.onCompact?.();
              }}
            >
              ${options.compactBusy ? icons.loader : icons.minimize}
              <span>${options.compactBusy ? "Compacting" : "Compact"}</span>
            </button>
          `
        : nothing}
    </div>
  `;
}

export type ChatRunControlsProps = {
  canAbort: boolean;
  connected: boolean;
  draft: string;
  hasMessages: boolean;
  isBusy: boolean;
  sending: boolean;
  onAbort?: () => void;
  onExport: () => void;
  onNewSession: () => void;
  onSend: () => void;
  onStoreDraft: (draft: string) => void;
  showSecondary?: boolean;
};

export function renderChatRunControls(props: ChatRunControlsProps) {
  const showSecondary = props.showSecondary ?? true;
  const storeDraftAndSend = () => {
    if (props.draft.trim()) {
      props.onStoreDraft(props.draft);
    }
    props.onSend();
  };

  return html`
    <div class="agent-chat__toolbar-right">
      ${showSecondary && !props.canAbort
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.newSession")}>
              <button
                class="btn btn--ghost"
                @click=${props.onNewSession}
                aria-label=${t("chat.runControls.newSession")}
              >
                ${icons.plus}
                <span class="agent-chat__control-label">${t("chat.runControls.newSession")}</span>
              </button>
            </openclaw-tooltip>
          `
        : nothing}
      ${showSecondary
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.export")}>
              <button
                class="btn btn--ghost"
                @click=${props.onExport}
                aria-label=${t("chat.runControls.exportChat")}
                ?disabled=${!props.hasMessages}
              >
                ${icons.download}
                <span class="agent-chat__control-label">${t("chat.runControls.export")}</span>
              </button>
            </openclaw-tooltip>
          `
        : nothing}
      ${props.canAbort
        ? html`
            <openclaw-tooltip .content=${t("chat.runControls.queue")}>
              <button
                class="chat-send-btn"
                @click=${storeDraftAndSend}
                ?disabled=${!props.connected || props.sending}
                aria-label=${t("chat.runControls.queueMessage")}
              >
                ${icons.send}
                <span class="agent-chat__control-label">${t("chat.runControls.queue")}</span>
              </button>
            </openclaw-tooltip>
            <openclaw-tooltip .content=${t("chat.runControls.stop")}>
              <button
                class="chat-send-btn chat-send-btn--stop"
                @click=${props.onAbort}
                aria-label=${t("chat.runControls.stopGenerating")}
              >
                ${icons.stop}
                <span class="agent-chat__control-label">${t("chat.runControls.stop")}</span>
              </button>
            </openclaw-tooltip>
          `
        : html`
            <openclaw-tooltip
              .content=${props.isBusy ? t("chat.runControls.queue") : t("chat.runControls.send")}
            >
              <button
                class="chat-send-btn"
                @click=${storeDraftAndSend}
                ?disabled=${!props.connected || props.sending}
                aria-label=${props.isBusy
                  ? t("chat.runControls.queueMessage")
                  : t("chat.runControls.sendMessage")}
              >
                ${icons.send}
                <span class="agent-chat__control-label"
                  >${props.isBusy ? t("chat.runControls.queue") : t("chat.runControls.send")}</span
                >
              </button>
            </openclaw-tooltip>
          `}
    </div>
  `;
}
