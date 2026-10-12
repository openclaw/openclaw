import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { formatCompactTokenCount, formatCost, formatTimeAgo } from "../../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatMessageMetadataEnglish);

const CHAT_RELATIVE_TIMESTAMP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_RELATIVE_TIMESTAMP_FUTURE_SKEW_MS = 2 * 60 * 1000;

function prepareTimestamp(timestamp: number) {
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
  return { dateTime: valid ? date.toISOString() : "", label, title, relativeLabel };
}

function TimestampTime(props: { view: ReturnType<typeof prepareTimestamp> }) {
  return (
    <time class="chat-group-timestamp" datetime={props.view.dateTime} aria-live="off">
      {props.view.relativeLabel}
    </time>
  );
}

export function renderSolidChatTimestamp(timestamp: number, metadata: JSX.Element[] = []) {
  return <ChatTimestamp timestamp={timestamp} metadata={metadata} />;
}

export function ChatTimestamp(props: { timestamp: number; metadata?: JSX.Element[] }) {
  const view = createMemo(() => prepareTimestamp(props.timestamp));
  const hasMetadata = () => Boolean(props.metadata?.length);
  return (
    <openclaw-tooltip
      class="msg-meta"
      prop:openOnClick={hasMetadata()}
      prop:content={hasMetadata() ? "" : view().label}
    >
      <Show when={hasMetadata()} fallback={<TimestampTime view={view()} />}>
        <button
          type="button"
          class="msg-meta__summary"
          aria-label={t("chat.messages.contextFor", { timestamp: view().title })}
        >
          <TimestampTime view={view()} />
        </button>
      </Show>
      <Show when={hasMetadata()}>
        <span slot="content" class="msg-meta__details">
          <span class="msg-meta__time">{view().label}</span>
          {props.metadata}
        </span>
      </Show>
    </openclaw-tooltip>
  );
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
    // SAFETY: Grouped transcript entries are admitted message objects; the role is checked below.
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant") {
      continue;
    }
    // SAFETY: The message producer supplies numeric token counts under these usage field names.
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
      // SAFETY: Assistant usage stores a structured cost separately from its numeric token fields.
      (usage as { cost?: { total?: number } } | undefined)?.cost ??
      // SAFETY: The fallback reads the same total-only cost shape as the usage metadata above.
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

const TOKEN_FIELDS = [
  ["input", "↑", "msg-meta__tokens"],
  ["output", "↓", "msg-meta__tokens"],
  ["cacheRead", "R", "msg-meta__cache"],
  ["cacheWrite", "W", "msg-meta__cache"],
] as const;

function MessageMetadata(props: { meta: GroupMeta | null }) {
  return (
    <>
      <For each={TOKEN_FIELDS} keyed={(entry) => entry[0]}>
        {(entry) => (
          <Show when={props.meta?.[entry()[0]]}>
            <span class={entry()[2]}>
              {entry()[1]}
              {formatCompactTokenCount(props.meta?.[entry()[0]] ?? 0)}
            </span>
          </Show>
        )}
      </For>
      <Show when={props.meta && props.meta.cost > 0}>
        <span class="msg-meta__cost">{formatCost(props.meta?.cost ?? 0)}</span>
      </Show>
      <Show when={props.meta && props.meta.contextPercent !== null}>
        <span
          class={[
            "msg-meta__ctx",
            {
              "msg-meta__ctx--danger": (props.meta?.contextPercent ?? 0) >= 90,
              "msg-meta__ctx--warn":
                (props.meta?.contextPercent ?? 0) >= 75 && (props.meta?.contextPercent ?? 0) < 90,
            },
          ]}
        >
          {props.meta?.contextPercent}
          {"% ctx"}
        </span>
      </Show>
      <Show when={props.meta?.model}>
        <span class="msg-meta__model">{props.meta?.model?.split("/").pop()}</span>
      </Show>
    </>
  );
}

export function MessageMeta(props: { timestamp: number; meta: GroupMeta | null }) {
  const metadata = [<MessageMetadata meta={props.meta} />];
  const hasMetadata = () =>
    props.meta &&
    Boolean(
      props.meta.input ||
      props.meta.output ||
      props.meta.cacheRead ||
      props.meta.cacheWrite ||
      props.meta.cost > 0 ||
      props.meta.contextPercent !== null ||
      props.meta.model,
    );
  return (
    <ChatTimestamp timestamp={props.timestamp} metadata={hasMetadata() ? metadata : undefined} />
  );
}
