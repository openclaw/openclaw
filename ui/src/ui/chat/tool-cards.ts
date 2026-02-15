import { html, nothing } from "lit";
import type { ToolCard } from "../types/chat-types.ts";
import { icons } from "../icons.ts";
import { formatToolDetail, resolveToolDisplay } from "../tool-display.ts";
import { TOOL_INLINE_THRESHOLD } from "./constants.ts";
import { extractTextCached } from "./message-extract.ts";
import { isToolResultMessage } from "./message-normalizer.ts";
import { formatToolOutputForSidebar, formatOutputLength } from "./tool-helpers.ts";

export function extractToolCards(message: unknown): ToolCard[] {
  const m = message as Record<string, unknown>;
  const content = normalizeContent(m.content);
  const cards: ToolCard[] = [];

  for (const item of content) {
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
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
    const kind = (typeof item.type === "string" ? item.type : "").toLowerCase();
    if (kind !== "toolresult" && kind !== "tool_result") {
      continue;
    }
    const text = extractToolText(item);
    const name = typeof item.name === "string" ? item.name : "tool";
    cards.push({ kind: "result", name, text });
  }

  if (isToolResultMessage(message) && !cards.some((card) => card.kind === "result")) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractTextCached(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

/**
 * Render a tool card with collapsible details.
 * - Short outputs (<80 chars) are shown inline
 * - Medium outputs show a 2-line preview with expand option
 * - All outputs can open in sidebar for full view
 */
export function renderToolCardSidebar(card: ToolCard, onOpenSidebar?: (content: string) => void) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());
  const textLength = card.text?.length ?? 0;

  const canClick = Boolean(onOpenSidebar);
  const handleOpenSidebar = canClick
    ? () => {
        if (hasText) {
          onOpenSidebar!(formatToolOutputForSidebar(card.text!));
          return;
        }
        const info = `## ${display.label}\n\n${
          detail ? `**Command:** \`${detail}\`\n\n` : ""
        }*No output — tool completed successfully.*`;
        onOpenSidebar!(info);
      }
    : undefined;

  const isShort = hasText && textLength <= TOOL_INLINE_THRESHOLD;
  const isEmpty = !hasText;

  // Short inline output - show directly
  if (isShort) {
    return html`
      <div
        class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
        @click=${handleOpenSidebar}
        role=${canClick ? "button" : nothing}
        tabindex=${canClick ? "0" : nothing}
        @keydown=${canClick ? handleKeydown(handleOpenSidebar) : nothing}
      >
        <div class="chat-tool-card__header">
          <div class="chat-tool-card__title">
            <span class="chat-tool-card__icon">${icons[display.icon]}</span>
            <span>${display.label}</span>
          </div>
          <span class="chat-tool-card__status">${icons.check}</span>
        </div>
        ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
        <div class="chat-tool-card__inline">${card.text}</div>
      </div>
    `;
  }

  // Empty result - compact card
  if (isEmpty) {
    return html`
      <div
        class="chat-tool-card ${canClick ? "chat-tool-card--clickable" : ""}"
        @click=${handleOpenSidebar}
        role=${canClick ? "button" : nothing}
        tabindex=${canClick ? "0" : nothing}
        @keydown=${canClick ? handleKeydown(handleOpenSidebar) : nothing}
      >
        <div class="chat-tool-card__header">
          <div class="chat-tool-card__title">
            <span class="chat-tool-card__icon">${icons[display.icon]}</span>
            <span>${display.label}</span>
          </div>
          <span class="chat-tool-card__status">${icons.check}</span>
        </div>
        ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
        <div class="chat-tool-card__status-text">Completed</div>
      </div>
    `;
  }

  // Expandable output - collapsed by default with details/summary
  return html`
    <div class="chat-tool-card">
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${icons[display.icon]}</span>
          <span>${display.label}</span>
        </div>
        ${
          canClick
            ? html`
              <button
                class="chat-tool-card__action"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  handleOpenSidebar?.();
                }}
                title="View in sidebar"
              >
                Open ${icons.check}
              </button>
            `
            : html`<span class="chat-tool-card__status">${icons.check}</span>`
        }
      </div>
      ${detail ? html`<div class="chat-tool-card__detail">${detail}</div>` : nothing}
      <details class="chat-tool-card__details">
        <summary class="chat-tool-card__summary">
          <span class="chat-tool-card__summary-text">Show output</span>
          <span class="chat-tool-card__summary-meta">${formatOutputLength(textLength)}</span>
        </summary>
        <div class="chat-tool-card__output">${card.text}</div>
      </details>
    </div>
  `;
}

/**
 * Render multiple tool cards in a compact group.
 */
export function renderToolCardsGroup(cards: ToolCard[], onOpenSidebar?: (content: string) => void) {
  if (cards.length === 0) {
    return nothing;
  }

  if (cards.length === 1) {
    return renderToolCardSidebar(cards[0], onOpenSidebar);
  }

  return html`
    <div class="chat-tool-group">
      ${cards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
    </div>
  `;
}

function handleKeydown(handler?: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") {
      return;
    }
    e.preventDefault();
    handler?.();
  };
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
