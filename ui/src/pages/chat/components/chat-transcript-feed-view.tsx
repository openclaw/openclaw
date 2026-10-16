import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, For } from "solid-js";
import "../../../styles/chat/transcript-feed.css";
import { stripShellPreamble } from "../../../../../src/agents/tool-display-exec-shell.js";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../../src/chat/tool-content.js";
import { resolveAssistantMessagePhase } from "../../../../../src/shared/chat-message-content.js";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import type { NormalizedMessage, ToolCard } from "../../../lib/chat/chat-types.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeMessage,
} from "../../../lib/chat/message-normalizer.ts";
import { describeToolGroup, readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import { resolveToolCallView } from "../../../lib/chat/tool-call-view.ts";
import {
  extractToolCardsCached,
  isToolCardError,
  isToolCallContentBlock,
  resolveToolCardDisplay,
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { resolveCappedMessageId } from "../chat-message-recovery.ts";
import { ownSessionLaunchCalls } from "../chat-spawned-subagent.ts";
import { buildMessageItems, rawMessageTimestamp } from "../chat-thread-items.ts";
import { coalesceToolActivityMessages } from "../chat-tool-activity-coalesce.ts";
import { ForwardedAttribution } from "./chat-forwarded-attribution.tsx";
import { MessageMarkdown } from "./chat-message-text-view.tsx";

type Entry = { key: string; timestamp: number | null } & (
  | {
      kind: "tools";
      calls: Array<{ key: string; card: ToolCard }>;
      activity: ReturnType<typeof readPreparedActivity>;
    }
  | {
      kind: "user" | "assistant" | "block";
      text: string;
      cappedMessageId?: string;
      senderSession?: NormalizedMessage["senderSession"];
    }
);

function entries(messages: unknown[]): Entry[] {
  const result: Entry[] = [];
  // Give inferred calls the canonical block type before message normalization,
  // which otherwise drops untyped blocks without text.
  const history: unknown[] = [];
  for (const message of messages) {
    const raw = asNullableRecord(message);
    let content: unknown[] | undefined;
    if (Array.isArray(raw?.content)) {
      for (const [index, value] of raw.content.entries()) {
        const block = asNullableRecord(value);
        if (block && !isToolCallContentType(block.type) && isToolCallContentBlock(block)) {
          content ??= raw.content.slice();
          content[index] = { ...block, type: "tool_call" };
        }
      }
    }
    history.push(content ? { ...raw, content } : message);
  }
  for (const item of coalesceToolActivityMessages(buildMessageItems(history))) {
    if (item.kind !== "message" || isStandaloneToolMessageForDisplay(item.message)) {
      continue;
    }
    const normalized = normalizeMessage(item.message);
    const cards = extractToolCardsCached(item.message);
    // Normalization reports a tool role for assistant messages that carry tool
    // calls; the cap contract is keyed on the source role.
    const sourceRole = asNullableRecord(item.message)?.role;
    const cappedMessageId = resolveCappedMessageId(
      item.message,
      typeof sourceRole === "string" ? sourceRole : normalized.role,
    );
    let callIndex = 0;
    let cappedEntry: Extract<Entry, { text: string }> | undefined;
    const timestamp = rawMessageTimestamp(item.message);
    for (const [index, block] of normalized.content.entries()) {
      const key = `${item.key}:${index}`;
      if (isToolCallContentBlock(block)) {
        const call = cards[callIndex++];
        if (!call) {
          continue;
        }
        const previous = result.at(-1);
        if (previous?.kind === "tools") {
          previous.calls.push({ key, card: call });
          if (call.activity) {
            previous.activity.push(call.activity);
          }
        } else {
          result.push({
            kind: "tools",
            key,
            timestamp,
            calls: [{ key, card: call }],
            activity: call.activity ? [call.activity] : [],
          });
        }
      } else if (
        isToolResultContentType(block.type) ||
        ["thinking", "commentary"].includes(block.type)
      ) {
        continue;
      } else if (block.type === "text") {
        if (resolveAssistantMessagePhase(item.message) === "commentary") {
          continue;
        }
        const text =
          normalized.role === "user"
            ? flattenMarkdownToPlainText(block.text ?? "")
            : stripThinkingTags(block.text ?? "");
        if (!text.trim()) {
          continue;
        }
        // Keep capped preview identity stable across text blocks surrounding tool calls.
        if (cappedMessageId && cappedEntry?.cappedMessageId === cappedMessageId) {
          cappedEntry.text = `${cappedEntry.text}\n\n${text}`;
          continue;
        }
        const entry: Entry = {
          kind: normalized.role === "user" ? "user" : "assistant",
          key,
          timestamp,
          text,
          cappedMessageId,
          senderSession: normalized.role === "user" ? undefined : normalized.senderSession,
        };
        cappedEntry = cappedMessageId ? entry : undefined;
        result.push(entry);
      } else {
        const raw = asNullableRecord(item.message);
        const source = asNullableRecord(
          Array.isArray(raw?.content) ? raw.content[index] : undefined,
        );
        const name =
          "attachment" in block ? block.attachment.label : (source?.fileName ?? source?.name);
        result.push({
          kind: "block",
          key,
          timestamp,
          text: [block.type, typeof name === "string" ? name : undefined]
            .filter(Boolean)
            .join(": "),
        });
      }
    }
  }
  return result;
}

function toolIcon(call: ToolCard): IconName {
  switch (resolveToolCallView(call).kind) {
    case "read":
      return "fileText";
    case "edit":
    case "write":
      return "pencil";
    case "search":
    case "fetch":
      return "search";
    default:
      return "terminal";
  }
}

function ToolLine(props: { call: ToolCard }) {
  const call = createMemo(() => resolveToolCardDisplay(props.call));
  const view = createMemo(() => resolveToolCallView(call()));
  const raw = () => (view().command ?? view().code ?? call().inputText ?? call().name).trim();
  const label = () => {
    const current = view();
    const command = current.command ? stripShellPreamble(current.command).command : undefined;
    return truncateUtf16Safe(
      current.title ??
        current.target ??
        (command || current.command)?.split("\n")[0] ??
        call().name,
      160,
    );
  };
  const outcome = createMemo(() => resolveToolCardOutcome(call(), false));
  const outcomeLabel = () =>
    t(
      `chat.toolCards.${outcome() === "succeeded" ? "completed" : outcome() === "unknown" ? "outcomeUnknown" : outcome()}`,
    );
  return (
    <details
      class={["chat-task-feed__tool-line", { "chat-task-feed__error": isToolCardError(call()) }]}
    >
      <summary>
        <span class="chat-task-feed__row-icon" aria-hidden="true">
          <Icon name={toolIcon(call())} />
        </span>
        <span class="chat-task-feed__row-label">{label()}</span>
        <span class="chat-task-feed__row-outcome" title={outcomeLabel()}>
          {outcome() === "succeeded" ? (
            <span role="img" aria-label={outcomeLabel()}>
              <Icon name="check" />
            </span>
          ) : (
            outcomeLabel()
          )}
        </span>
        <span class="chat-task-feed__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <pre class="chat-task-feed__tool-line--full">
        <code>{raw()}</code>
      </pre>
    </details>
  );
}

function ToolGroup(props: { entry: Extract<Entry, { kind: "tools" }> }) {
  const overview = createMemo(() =>
    describeToolGroup(props.entry.activity, {
      ownSessionLaunches: ownSessionLaunchCalls(props.entry.calls.map(({ card }) => card)),
    }),
  );
  return (
    <details class="chat-task-feed__tool-group">
      <summary>
        <span class="chat-task-feed__overview">
          <span class="chat-task-feed__overview-heading">
            <strong>
              {overview().total
                ? t(`chat.toolCards.activity.title${overview().total === 1 ? "One" : "Many"}`, {
                    count: String(overview().total),
                  })
                : t("chat.toolCards.rawDetails")}
            </strong>
            <For each={overview().outcomes} keyed={(outcome) => outcome.kind}>
              {(outcome) => (
                <span class={`chat-task-feed__outcome chat-task-feed__outcome--${outcome().kind}`}>
                  {outcome().label}{" "}
                </span>
              )}
            </For>
          </span>
          {overview().label && <span class="chat-task-feed__summary">{overview().label}</span>}
        </span>
        <span class="chat-task-feed__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </summary>
      <div class="chat-task-feed__calls">
        <For each={props.entry.calls} keyed={(call) => call.key}>
          {(call) => <ToolLine call={call().card} />}
        </For>
      </div>
    </details>
  );
}

function FeedEntry(props: { entry: Entry }) {
  return (
    <div class="chat-task-feed__entry" data-task-feed-entry={props.entry.key}>
      <span class="chat-task-feed__icon" aria-hidden="true">
        <Icon
          name={
            props.entry.kind === "tools"
              ? toolIcon(props.entry.calls[0]!.card)
              : props.entry.kind === "user"
                ? "users"
                : props.entry.kind === "block"
                  ? "paperclip"
                  : "messageSquare"
          }
        />
      </span>
      <div class="chat-task-feed__body">
        {props.entry.kind === "assistant" && props.entry.senderSession ? (
          <ForwardedAttribution group={props.entry} options={{ linkSource: false }} />
        ) : (
          (props.entry.kind === "user" || props.entry.kind === "assistant") && (
            <span class="sr-only">{t(`sessionsView.${props.entry.kind}`)}: </span>
          )
        )}
        {props.entry.kind === "tools" ? (
          <ToolGroup entry={props.entry} />
        ) : props.entry.kind === "assistant" ? (
          <MessageMarkdown
            markdown={props.entry.text}
            messageKey={props.entry.key}
            options={{ role: "assistant", isStreaming: false }}
            markdownOptions={{}}
          />
        ) : (
          <div class={`chat-task-feed__${props.entry.kind}`}>{props.entry.text}</div>
        )}
      </div>
      {props.entry.timestamp !== null && (
        <time class="chat-task-feed__time" datetime={new Date(props.entry.timestamp).toISOString()}>
          {new Date(props.entry.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </time>
      )}
    </div>
  );
}

export function ChatTranscriptFeed(props: { messages: unknown[] }) {
  const feed = createMemo(() => entries(props.messages));
  return (
    <div class="chat-task-feed">
      <For each={feed()} keyed={(entry) => entry.key}>
        {(entry) => <FeedEntry entry={entry()} />}
      </For>
    </div>
  );
}
