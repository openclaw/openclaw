import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount, formatCost, formatTimeAgo } from "../../../lib/format.ts";

registerChatMessageMetadataEnglish();

const CHAT_RELATIVE_TIMESTAMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_RELATIVE_TIMESTAMP_FUTURE_SKEW_MS = 2 * 60 * 1000;

export function renderChatTimestamp(timestamp: number, metadata: TemplateResult[] = []) {
  const date = new Date(timestamp);
  const valid = Number.isFinite(date.getTime());
  const label = valid
    ? date.toLocaleString([], {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      })
    : t("chat.messages.unknownDate");
  const title = valid
    ? date.toLocaleString([], {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })
    : label;
  const nowMs = Date.now();
  const ageMs = nowMs - date.getTime();
  // Slightly-future messages clamp to "just now"; older or distant-future ones use a date.
  const relativeLabel = !valid
    ? label
    : ageMs >= -CHAT_RELATIVE_TIMESTAMP_FUTURE_SKEW_MS && ageMs < CHAT_RELATIVE_TIMESTAMP_MAX_AGE_MS
      ? formatTimeAgo(Math.max(0, ageMs))
      : date.toLocaleDateString([], {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
        });
  const time = html`
    <time class="chat-group-timestamp" datetime=${valid ? date.toISOString() : ""} aria-live="off">
      ${relativeLabel}
    </time>
  `;
  return html`
    <openclaw-tooltip
      class="msg-meta"
      ?open-on-click=${metadata.length > 0}
      content=${metadata.length ? "" : label}
    >
      ${
        metadata.length
          ? html`<button
              type="button"
              class="msg-meta__summary"
              aria-label=${t("chat.messages.contextFor", { timestamp: title })}
            >
              ${time}
            </button>`
          : time
      }
      ${
        metadata.length
          ? html`<span slot="content" class="msg-meta__details">
              <span class="msg-meta__time">${label}</span>${metadata}
            </span>`
          : nothing
      }
    </openclaw-tooltip>
  `;
}

type GroupMeta = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model: string | null;
  contextPercent: number | null;
};

export function extractGroupMeta(
  group: MessageGroup,
  contextWindow: number | null,
): GroupMeta | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let model: string | null = null;
  let hasUsage = false;
  let maxPromptTokens = 0;

  for (const { message } of group.messages) {
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant") {
      continue;
    }
    const usage = m.usage as Record<string, number> | undefined;
    if (usage) {
      hasUsage = true;
      const callInput = usage.input ?? usage.inputTokens ?? 0;
      const callOutput = usage.output ?? usage.outputTokens ?? 0;
      const callCacheRead = usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
      const callCacheWrite = usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0;
      input += callInput;
      output += callOutput;
      cacheRead += callCacheRead;
      cacheWrite += callCacheWrite;
      maxPromptTokens = Math.max(maxPromptTokens, callInput + callCacheRead + callCacheWrite);
    }
    // Producers write cost nested under usage.cost (the AssistantMessage
    // shape); a bare message.cost never exists, so reading only it left the
    // popover's $ line permanently dead.
    const c =
      (usage as { cost?: { total?: number } } | undefined)?.cost ??
      (m.cost as Record<string, number> | undefined);
    if (c?.total) {
      cost += c.total;
    }
    if (typeof m.model === "string" && m.model !== "gateway-injected") {
      model = m.model;
    }
  }

  if (!hasUsage && !model) {
    return null;
  }

  const contextPercent =
    contextWindow && maxPromptTokens > 0
      ? Math.min(Math.round((maxPromptTokens / contextWindow) * 100), 100)
      : null;

  return { input, output, cacheRead, cacheWrite, cost, model, contextPercent };
}

export function renderMessageMeta(timestamp: number, meta: GroupMeta | null) {
  if (!meta) {
    return renderChatTimestamp(timestamp);
  }

  const parts: Array<ReturnType<typeof html>> = [];

  for (const [value, prefix, className] of [
    [meta.input, "↑", "msg-meta__tokens"],
    [meta.output, "↓", "msg-meta__tokens"],
    [meta.cacheRead, "R", "msg-meta__cache"],
    [meta.cacheWrite, "W", "msg-meta__cache"],
  ] as const) {
    if (value) {
      parts.push(html`<span class=${className}>${prefix}${formatCompactTokenCount(value)}</span>`);
    }
  }

  if (meta.cost > 0) {
    parts.push(html`<span class="msg-meta__cost">${formatCost(meta.cost)}</span>`);
  }

  if (meta.contextPercent !== null) {
    const pct = meta.contextPercent;
    const cls =
      pct >= 90
        ? "msg-meta__ctx msg-meta__ctx--danger"
        : pct >= 75
          ? "msg-meta__ctx msg-meta__ctx--warn"
          : "msg-meta__ctx";
    parts.push(html`<span class="${cls}">${pct}% ctx</span>`);
  }

  if (meta.model) {
    const shortModel = meta.model.includes("/") ? meta.model.split("/").pop()! : meta.model;
    parts.push(html`<span class="msg-meta__model">${shortModel}</span>`);
  }

  return renderChatTimestamp(timestamp, parts);
}
