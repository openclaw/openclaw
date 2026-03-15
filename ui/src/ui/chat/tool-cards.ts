import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import type { ToolCard } from "../types/chat-types.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import {
  formatToolArgsForSidebar,
  formatToolOutputForSidebar,
  getTruncatedPreview,
} from "./tool-helpers.ts";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  // Build lookup maps from tool calls for result-card arg pairing
  const argsByToolCallId = new Map<string, unknown>();
  // Use per-name queue for ordered matching (FIFO) instead of last-wins
  const argsQueueByName = new Map<string, unknown[]>();

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      const name = (item.name as string) ?? "tool";
      const args = coerceArgs(item.arguments ?? item.args);
      cards.push({
        kind: "call",
        name,
        args,
      });
      // Index by toolCallId if present
      const toolCallId =
        (item.toolCallId as string) ?? (item.tool_call_id as string) ?? (item.id as string);
      if (toolCallId) {
        argsByToolCallId.set(toolCallId, args);
      }
      // Push to per-name queue for ordered matching
      if (!argsQueueByName.has(name)) {
        argsQueueByName.set(name, []);
      }
      argsQueueByName.get(name)!.push(args);
    }
  }

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") {
      continue;
    }
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    // Try to get args from the result block first, then look up paired tool call
    let args = coerceArgs(item.arguments ?? item.args);
    // Try matching by toolCallId first
    const toolCallId =
      (item.toolCallId as string) ?? (item.tool_call_id as string) ?? (item.id as string);
    if (toolCallId && argsByToolCallId.has(toolCallId)) {
      args = argsByToolCallId.get(toolCallId);
    } else if (args === undefined || args === null) {
      // Only use queue fallback if we don't have args yet
      if (argsQueueByName.has(name)) {
        const queue = argsQueueByName.get(name)!;
        if (queue.length > 0) {
          args = queue.shift();
        }
      }
    }
    // Always consume matching queue entry to keep queue in sync
    // (for results matched by toolCallId or with their own args)
    if (argsQueueByName.has(name)) {
      const queue = argsQueueByName.get(name)!;
      // Find and remove the args we matched (by reference or position)
      // For toolCallId match, remove the first entry (FIFO preserves order)
      // For own-args, also remove first to keep queue aligned with call order
      if (queue.length > 0) {
        queue.shift();
      }
    }
    cards.push({
      kind: "result",
      name,
      args,
      text,
    });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    // Also try to look up args from any prior tool call by name (FIFO)
    let args = coerceArgs(m.arguments ?? m.args);
    if ((args === undefined || args === null) && argsQueueByName.has(name)) {
      const queue = argsQueueByName.get(name)!;
      if (queue.length > 0) {
        args = queue.shift();
      }
    }
    cards.push({ kind: "result", name, text, args });
  }

  return cards;
}

export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());

  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick
    ? () => {
        // Lazy compute args sections only when sidebar is opened
        const argsSections = formatToolArgsForSidebar(card.args);
        const headerParts = [`## ${display.label}`];
        if (argsSections.length > 0) {
          headerParts.push(
            ...argsSections.map((section) => `**${section.label}:**\n${section.body}`),
          );
        } else if (detail) {
          headerParts.push(`**Command:** \`${detail}\``);
        }
        const header = `${headerParts.join("\n\n")}\n\n`;
        if (hasText) {
          onOpenSidebar!(`${header}${formatToolOutputForSidebar(card.text!)}`);
          return;
        }
        onOpenSidebar!(`${header}*No output — tool completed successfully.*`);
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText;

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${
        canClick
          ? (e: KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") {
                return;
              }
              e.preventDefault();
              handleClick?.();
            }
          : nothing
      }
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${
          canClick
            ? html`<span class="chat-tool-card__action">${hasText ? "View" : ""} ${icons.check}</span>`
            : nothing
        }
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">${icons.check}</span>` : nothing}
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      ${
        isEmpty
          ? html`
              <div class="chat-tool-card__status-text muted">Completed</div>
            `
          : nothing
      }
      ${
        showCollapsed
          ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
          : nothing
      }
      ${showInline ? html`<div class="chat-tool-card__inline mono">${card.text}</div>` : nothing}
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  return undefined;
}
