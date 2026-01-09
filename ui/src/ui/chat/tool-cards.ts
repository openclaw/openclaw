import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import { toSanitizedMarkdownHtml } from "../markdown";
import { formatToolDetail, resolveToolDisplay } from "../tool-display";
import type { ToolCard } from "../types/chat-types";
import { TOOL_INLINE_THRESHOLD } from "./constants";
import {
  formatToolOutputForSidebar,
  getTruncatedPreview,
} from "./tool-helpers";
import { isToolResultMessage } from "./message-normalizer";
import { extractText } from "./message-extract";

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
    cards.push({ kind: "result", name, text });
  }

  if (
    isToolResultMessage(message) &&
    !cards.some((card) => card.kind === "result")
  ) {
    const name =
      (typeof m.toolName === "string" && m.toolName) ||
      (typeof m.tool_name === "string" && m.tool_name) ||
      "tool";
    const text = extractText(message) ?? undefined;
    cards.push({ kind: "result", name, text });
  }

  return cards;
}

export function renderToolCardLegacy(
  card: ToolCard,
  opts?: {
    id: string;
    expanded: boolean;
    onToggle?: (id: string, expanded: boolean) => void;
  },
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasOutput = typeof card.text === "string" && card.text.length > 0;
  const expanded = opts?.expanded ?? false;
  const id = opts?.id ?? `${card.name}-${Math.random()}`;
  return html`
    <div class="chat-tool-card">
      <div class="chat-tool-card__header">
        <div class="chat-tool-card__title">
          <span class="chat-tool-card__icon">${display.emoji}</span>
          <span>${display.label}</span>
        </div>
        ${!hasOutput ? html`<span class="chat-tool-card__status">✓</span>` : nothing}
      </div>
      ${detail
        ? html`<div class="chat-tool-card__detail">${detail}</div>`
        : nothing}
      ${hasOutput
        ? html`
            <details
              class="chat-tool-card__details"
              ?open=${expanded}
              @toggle=${(e: Event) => {
                if (!opts?.onToggle) return;
                const target = e.currentTarget as HTMLDetailsElement;
                opts.onToggle(id, target.open);
              }}
            >
              <summary class="chat-tool-card__summary">
                ${expanded ? "Hide output" : "Show output"}
                <span class="chat-tool-card__summary-meta">
                  (${card.text?.length ?? 0} chars)
                </span>
              </summary>
              ${expanded
                ? html`<div class="chat-tool-card__output chat-text">
                    ${unsafeHTML(toSanitizedMarkdownHtml(card.text ?? ""))}
                  </div>`
                : nothing}
            </details>
          `
        : nothing}
    </div>
  `;
}

export function renderToolCardSidebar(
  card: ToolCard,
  onOpenSidebar?: (content: string) => void,
) {
  const display = resolveToolDisplay({ name: card.name, args: card.args });
  const detail = formatToolDetail(display);
  const hasText = Boolean(card.text?.trim());

  const canClick = Boolean(onOpenSidebar);
  const handleClick = canClick
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
          <span class="chat-tool-card__icon">${display.emoji}</span>
          <span>${display.label}</span>
        </div>
        ${canClick
          ? html`<span class="chat-tool-card__action">${hasText ? "View ›" : "›"}</span>`
          : nothing}
        ${isEmpty && !canClick ? html`<span class="chat-tool-card__status">✓</span>` : nothing}
      </div>
      ${detail
        ? html`<div class="chat-tool-card__detail">${detail}</div>`
        : nothing}
      ${isEmpty
        ? html`<div class="chat-tool-card__status-text muted">Completed</div>`
        : nothing}
      ${showCollapsed
        ? html`<div class="chat-tool-card__preview mono">${getTruncatedPreview(card.text!)}</div>`
        : nothing}
      ${showInline
        ? html`<div class="chat-tool-card__inline mono">${card.text}</div>`
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

