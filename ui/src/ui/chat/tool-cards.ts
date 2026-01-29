import { html, nothing } from "lit";

import { formatToolDetail, resolveToolDisplay } from "../tool-display";
import { icons } from "../icons";
import type { ToolCard } from "../types/chat-types";
import { TOOL_INLINE_THRESHOLD } from "./constants";
import {
  formatToolOutputForSidebar,
  getTruncatedPreview,
} from "./tool-helpers";
import { isToolResultMessage } from "./message-normalizer";
import { extractTextCached } from "./message-extract";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    const isToolCall =
      ["toolcall", "tool_call", "tooluse", "tool_use"].includes(kind) ||
      (typeof item.name === "string" && item.arguments != null);
    if (isToolCall) {
      cards.push({
        kind: "call",
        name: (item.name as string) ?? "tool",
        args: coerceArgs(item.arguments ?? item.args),
      });
    }
  }

  for (const item of content) {
    const kind = String(item.type ?? "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") continue;
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    const isError = item.isError === true;
    cards.push({ kind: "result", name, text, isError });
  }

  if (
    isToolResultMessage(message) &&
    !cards.some((card) => card.kind === "result")
  ) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

export function renderToolCardSidebar(
  card: ToolCard,
  onOpenSidebar?: (content: string) => void,
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());
  const isError = card.isError === true;

  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick
    ? () => {
        if (hasText) {
          const prefix = isError ? "## Error\n\n" : "";
          onOpenSidebar!(prefix + formatToolOutputForSidebar(card.text!));
          return;
        }
        const status = isError
          ? "*Tool failed with no error message.*"
          : "*No output — tool completed successfully.*";
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }${status}`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isShort = hasText && (card.text?.length ?? 0) <= TOOL_INLINE_THRESHOLD;
  const showCollapsed = hasText && !isShort;
  const showInline = hasText && isShort;
  const isEmpty = !hasText;

  const statusIcon = isError ? icons.x : icons.check;
  const statusClass = isError ? "chat-tool-card--error" : "";

  return html`
    <div
      class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""} ${statusClass}"
      @click=${handleClick}
      role=${canClick ? "button" : nothing}
      tabindex=${canClick ? "0" : nothing}
      @keydown=${canClick
        ? (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            handleClick?.();
          }
        : nothing}
    >
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${canClick
          ? html`<span class="chat-tool-card__action">${hasText ? "View" : ""} ${statusIcon}</span>`
          : nothing}
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">${statusIcon}</span>` : nothing}
      </div>
      ${detail
        ? html`<div class="chat-tool-card__detail">${detail}</div>`
        : nothing}
      ${isEmpty
        ? html`<div class="chat-tool-card__status-text ${isError ? "error" : "muted"}">${isError ? "Failed" : "Completed"}</div>`
        : nothing}
      ${showCollapsed
        ? html`<div class="chat-tool-card__preview mono ${isError ? "error" : ""}">${getTruncatedPreview(card.text!)}</div>`
        : nothing}
      ${showInline
        ? html`<div class="chat-tool-card__inline mono ${isError ? "error" : ""}">${card.text}</div>`
        : nothing}
    </div>
  `;
}

function normalizeContent(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(Boolean) as Array<Record<string, unknown>>;
}

function coerceArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function extractToolText(item: Record<string, unknown>): string | undefined {
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  return undefined;
}
