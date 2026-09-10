import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../../src/chat/tool-content.js";
import { resolveAssistantMessagePhase } from "../../../../../src/shared/chat-message-content.js";
import { icons } from "../../../components/icons.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeMessage,
} from "../../../lib/chat/message-normalizer.ts";
import { summarizeToolGroup } from "../../../lib/chat/tool-call-grouping.ts";
import {
  resolveToolCallTargetPaths,
  resolveToolCallView,
} from "../../../lib/chat/tool-call-view.ts";
import {
  extractToolCardsCached,
  isToolCardError,
  isToolCallContentBlock,
  resolveCollapsedToolArgumentPreview,
} from "../../../lib/chat/tool-cards.ts";
import { stripThinkingTags } from "../../../lib/strip-thinking-tags.ts";
import { buildMessageItems, rawMessageTimestamp } from "../chat-thread-items.ts";
import type { AssistantMessageExpansionState } from "../chat-thread.ts";
import { coalesceToolActivityMessages } from "../chat-tool-activity-coalesce.ts";
import {
  FULL_MESSAGE_RETRY_REVISION_LIMIT,
  resolveCappedMessageId,
} from "./chat-message-markdown.ts";
import { renderMessageMarkdown, type AssistantMessageDisclosure } from "./chat-message-text.ts";

type TaskMessageRecovery = {
  getState: (messageId: string) => AssistantMessageExpansionState | undefined;
  request: (messageId: string) => void;
};

type Entry = { key: string; timestamp: number | null } & (
  | { kind: "tools"; calls: ToolCard[] }
  | { kind: "user" | "assistant" | "block"; text: string; cappedMessageId?: string }
);

// Collapsed rows show the first line; expanded rows keep the complete command
// or script so a multi-line call can be inspected.
function toolLine(call: ToolCard, mode: "summary" | "full"): string {
  const view = resolveToolCallView(call);
  const text =
    view.command ??
    view.code ??
    (view.kind === "search" ? view.target : resolveToolCallTargetPaths(call.name, call.args)[0]) ??
    view.target ??
    [call.name, resolveCollapsedToolArgumentPreview(call.args)].filter(Boolean).join(" ");
  return mode === "full" ? text.trim() : text.split(/\r?\n/)[0]!.trim();
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
          previous.calls.push(call);
        } else {
          result.push({ kind: "tools", key, timestamp, calls: [call] });
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

function renderToolLine(call: ToolCard, mode: "summary" | "full") {
  // The text sits in an inline element so template whitespace stays outside
  // the `pre-wrap` region of expanded rows.
  return html`<div
    class="chat-task-feed__tool-line ${mode === "full" ? "chat-task-feed__tool-line--full" : ""} ${isToolCardError(call) ? "chat-task-feed__error" : ""}"
  >
    <code>${toolLine(call, mode)}</code>
  </div>`;
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
          >${entry.kind === "tools" ? toolIcon(entry.calls[0]!) : entry.kind === "user" ? icons.users : entry.kind === "block" ? icons.paperclip : icons.messageSquare}</span
        >
        <div class="chat-task-feed__body">
          ${
            entry.kind === "tools"
              ? html` <details class="chat-task-feed__tool-group">
                  <summary>
                    ${renderToolLine(entry.calls[0]!, "summary")}${entry.calls.length > 1 ? html`<div class="chat-task-feed__summary">${summarizeToolGroup(entry.calls)}</div>` : nothing}
                  </summary>
                  <div class="chat-task-feed__calls">
                    ${entry.calls.map((call) => renderToolLine(call, "full"))}
                  </div>
                </details>`
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
