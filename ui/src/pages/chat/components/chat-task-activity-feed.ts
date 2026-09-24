import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { stripShellPreamble } from "../../../../../src/agents/tool-display-exec-shell.js";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../../src/chat/tool-content.js";
import { resolveAssistantMessagePhase } from "../../../../../src/shared/chat-message-content.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { redactToolPayloadText } from "../../../lib/browser-redact.ts";
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
  resolveToolCardOutcome,
} from "../../../lib/chat/tool-cards.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import {
  resolveCappedMessageId,
  type AssistantMessageExpansionState,
} from "../chat-message-recovery.ts";
import { buildMessageItems, rawMessageTimestamp } from "../chat-thread-items.ts";
import { coalesceToolActivityMessages } from "../chat-tool-activity-coalesce.ts";
import { renderForwardedAttribution } from "./chat-forwarded-attribution.ts";
import { FULL_MESSAGE_RETRY_REVISION_LIMIT } from "./chat-message-markdown.ts";
import { renderMessageMarkdown, type AssistantMessageDisclosure } from "./chat-message-text.ts";

type TaskMessageRecovery = {
  getState: (messageId: string) => AssistantMessageExpansionState | undefined;
  request: (messageId: string) => void;
};

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

function toolLine(call: ToolCard): string {
  const view = resolveToolCallView(call);
  const text = view.command ?? view.code ?? call.inputText ?? call.name;
  return redactToolPayloadText(text.trim());
}

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
        // Recovery replaces the whole message's text, so a capped message keeps
        // one text entry; later text blocks join it instead of each rendering
        // the complete recovered reply.
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

function toolIcon(call: ToolCard) {
  switch (resolveToolCallView(call).kind) {
    case "read":
      return icons.fileText;
    case "edit":
    case "write":
      return icons.pencil;
    case "search":
    case "fetch":
      return icons.search;
    default:
      return icons.terminal;
  }
}

function renderToolLine(call: ToolCard) {
  const view = resolveToolCallView(call);
  const raw = toolLine(call);
  const command = view.command ? stripShellPreamble(view.command).command : undefined;
  const label = truncateUtf16Safe(
    redactToolPayloadText(
      view.title ?? view.target ?? (command || view.command)?.split("\n")[0] ?? call.name,
    ),
    160,
  );
  const outcome = resolveToolCardOutcome(call, false);
  const outcomeLabel = t(
    `chat.toolCards.${outcome === "succeeded" ? "completed" : outcome === "unknown" ? "outcomeUnknown" : outcome}`,
  );
  return html`<details
    class="chat-task-feed__tool-line ${isToolCardError(call) ? "chat-task-feed__error" : ""}"
  >
    <summary>
      <span class="chat-task-feed__row-icon" aria-hidden="true">${toolIcon(call)}</span>
      <span class="chat-task-feed__row-label">${label}</span>
      <span class="chat-task-feed__row-outcome" title=${outcomeLabel}
        >${outcome === "succeeded" ? html`<span role="img" aria-label=${outcomeLabel}>${icons.check}</span>` : outcomeLabel}</span
      >
      <span class="chat-task-feed__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <pre class="chat-task-feed__tool-line--full"><code>${raw}</code></pre>
  </details>`;
}

function renderToolGroup(entry: Extract<Entry, { kind: "tools" }>) {
  const overview = describeToolGroup(entry.activity);
  return html`<details class="chat-task-feed__tool-group">
    <summary>
      <span class="chat-task-feed__overview">
        <span class="chat-task-feed__overview-heading">
          <strong
            >${overview.total ? t(`chat.toolCards.activity.title${overview.total === 1 ? "One" : "Many"}`, { count: String(overview.total) }) : t("chat.toolCards.rawDetails")}</strong
          >
          ${overview.outcomes.map(({ kind, label }) => html`<span class="chat-task-feed__outcome chat-task-feed__outcome--${kind}">${label} </span>`)}
        </span>
        ${overview.label ? html`<span class="chat-task-feed__summary">${overview.label}</span>` : nothing}
      </span>
      <span class="chat-task-feed__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="chat-task-feed__calls">
      ${repeat(
        entry.calls,
        ({ key }) => key,
        ({ card }) => renderToolLine(card),
      )}
    </div>
  </details>`;
}

function messageDisclosure(
  entry: Entry,
  recovery?: TaskMessageRecovery,
): AssistantMessageDisclosure | undefined {
  const messageId = entry.kind === "assistant" ? entry.cappedMessageId : undefined;
  if (!messageId || !recovery) {
    return undefined;
  }
  const state = recovery.getState(messageId);
  if (!state || (state.status === "error" && state.revision < FULL_MESSAGE_RETRY_REVISION_LIMIT)) {
    recovery.request(messageId);
  }
  return {
    expanded: state?.status === "loaded",
    ...(state?.status === "loaded" ? { markdown: stripThinkingTags(state.markdown) } : {}),
    ...(state?.status === "error" && state.revision >= FULL_MESSAGE_RETRY_REVISION_LIMIT
      ? { onRetryFullMessage: () => recovery.request(messageId) }
      : {}),
  };
}

export function renderTaskActivityFeed(
  messages: unknown[],
  recovery?: TaskMessageRecovery,
): TemplateResult {
  return html`<div class="chat-task-feed">
    ${repeat(
      entries(messages),
      (entry) => entry.key,
      (entry) => html` <div class="chat-task-feed__entry" data-task-feed-entry=${entry.key}>
        <span class="chat-task-feed__icon" aria-hidden="true"
          >${entry.kind === "tools" ? toolIcon(entry.calls[0]!.card) : entry.kind === "user" ? icons.users : entry.kind === "block" ? icons.paperclip : icons.messageSquare}</span
        >
        <div class="chat-task-feed__body">
          ${
            entry.kind === "assistant" && entry.senderSession
              ? renderForwardedAttribution(entry, { linkSource: false })
              : entry.kind === "user" || entry.kind === "assistant"
                ? html`<span class="sr-only">${t(`sessionsView.${entry.kind}`)}: </span>`
                : nothing
          }
          ${
            entry.kind === "tools"
              ? renderToolGroup(entry)
              : entry.kind === "assistant"
                ? renderMessageMarkdown(
                    entry.text,
                    entry.key,
                    {
                      role: "assistant",
                      isStreaming: false,
                      assistantMessageDisclosure: messageDisclosure(entry, recovery),
                    },
                    {},
                  )
                : html`<div class="chat-task-feed__${entry.kind}">${entry.text}</div>`
          }
        </div>
        ${entry.timestamp !== null ? html`<time class="chat-task-feed__time" datetime=${new Date(entry.timestamp).toISOString()}>${new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</time>` : nothing}
      </div>`,
    )}
  </div>`;
}
