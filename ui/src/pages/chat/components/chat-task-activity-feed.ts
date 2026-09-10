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
import { coalesceToolActivityMessages } from "../chat-tool-activity-coalesce.ts";
import { renderMessageMarkdown } from "./chat-message-text.ts";

type Entry = { key: string; timestamp: number | null } & (
  | { kind: "tools"; calls: ToolCard[] }
  | { kind: "user" | "assistant" | "block"; text: string }
);

function toolLine(call: ToolCard): string {
  const view = resolveToolCallView(call);
  return (
    view.command ??
    view.code ??
    (view.kind === "search" ? view.target : resolveToolCallTargetPaths(call.name, call.args)[0]) ??
    view.target ??
    [call.name, resolveCollapsedToolArgumentPreview(call.args)].filter(Boolean).join(" ")
  )
    .split(/\r?\n/)[0]!
    .trim();
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
    let callIndex = 0;
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
        if (text.trim()) {
          result.push({
            kind: normalized.role === "user" ? "user" : "assistant",
            key,
            timestamp,
            text,
          });
        }
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
  return html`<div
    class="chat-task-feed__tool-line ${isToolCardError(call) ? "chat-task-feed__error" : ""}"
  >
    ${toolLine(call)}
  </div>`;
}

export function renderTaskActivityFeed(messages: unknown[]): TemplateResult {
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
                    ${renderToolLine(entry.calls[0]!)}${entry.calls.length > 1 ? html`<div class="chat-task-feed__summary">${summarizeToolGroup(entry.calls)}</div>` : nothing}
                  </summary>
                  <div class="chat-task-feed__calls">${entry.calls.map(renderToolLine)}</div>
                </details>`
              : entry.kind === "assistant"
                ? renderMessageMarkdown(
                    entry.text,
                    entry.key,
                    { role: "assistant", isStreaming: false },
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
