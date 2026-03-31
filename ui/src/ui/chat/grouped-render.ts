import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { AssistantIdentity } from "../assistant-identity.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import { openExternalUrlSafe } from "../open-external-url.ts";
import { detectTextDirection } from "../text-direction.ts";
import type { MessageGroup, ToolCard } from "../types/chat-types.ts";
import { agentLogoUrl } from "../views/agents-utils.ts";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown.ts";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract.ts";
import { isToolResultMessage, normalizeRoleForGrouping } from "./message-normalizer.ts";
import { isTtsSupported, speakText, stopTts, isTtsSpeaking } from "./speech.ts";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards.ts";

type ImageBlock = {
  url: string;
  alt?: string;
};

function extractImages(message: unknown): ImageBlock[] {
  const images: ImageBlock[] = [];
  const m = message as Record<string, unknown>;
  collectImagesFromContent(m.content, images);
  return images;
}

function collectImagesFromContent(content: unknown, images: ImageBlock[]) {
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const b = block as Record<string, unknown>;
    const type = typeof b.type === "string" ? b.type.toLowerCase() : "";

    if (type === "image") {
      // Handle source object format (from sendChatMessage)
      const source = b.source as Record<string, unknown> | undefined;
      if (source?.type === "base64" && typeof source.data === "string") {
        const data = source.data;
        const mediaType = (source.media_type as string) || "image/png";
        // If data is already a data URL, use it directly
        const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
        images.push({ url });
        continue;
      }
      if (typeof b.data === "string") {
        const data = b.data;
        const mediaType = typeof b.mimeType === "string" ? b.mimeType : "image/png";
        const url = data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`;
        images.push({ url });
        continue;
      }
      if (typeof b.url === "string") {
        images.push({ url: b.url });
      }
      continue;
    }

    if (type === "image_url") {
      // OpenAI format
      const imageUrl = b.image_url as Record<string, unknown> | undefined;
      if (typeof imageUrl?.url === "string") {
        images.push({ url: imageUrl.url });
      }
      continue;
    }

    if (Array.isArray(b.content)) {
      collectImagesFromContent(b.content, images);
    }
  }
}

export function renderReadingIndicatorGroup(assistant?: AssistantIdentity, basePath?: string) {
  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant, basePath)}
      <div class="chat-group-messages">
        <div class="chat-bubble chat-reading-indicator" aria-hidden="true">
          <span class="chat-reading-indicator__dots">
            <span></span><span></span><span></span>
          </span>
        </div>
      </div>
    </div>
  `;
}

export function renderStreamingGroup(
  text: string,
  startedAt: number,
  onOpenSidebar?: (content: string) => void,
  assistant?: AssistantIdentity,
  basePath?: string,
) {
  const timestamp = new Date(startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const name = assistant?.name ?? "Assistant";

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant, basePath)}
      <div class="chat-group-messages">
        ${renderGroupedMessage(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: startedAt,
          },
          { isStreaming: true, showReasoning: false },
          onOpenSidebar,
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${name}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

export function renderMessageGroup(
  group: MessageGroup,
  opts: {
    onOpenSidebar?: (content: string) => void;
    showReasoning: boolean;
    showToolCalls?: boolean;
    assistantName?: string;
    assistantAvatar?: string | null;
    basePath?: string;
    contextWindow?: number | null;
    onDelete?: () => void;
  },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const assistantName = opts.assistantName ?? "Assistant";
  const userLabel = group.senderLabel?.trim();
  const who =
    normalizedRole === "user"
      ? (userLabel ?? "You")
      : normalizedRole === "assistant"
        ? assistantName
        : normalizedRole === "tool"
          ? "Tool"
          : normalizedRole;
  const roleClass =
    normalizedRole === "user"
      ? "user"
      : normalizedRole === "assistant"
        ? "assistant"
        : normalizedRole === "tool"
          ? "tool"
          : "other";
  const timestamp = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  // Aggregate usage/cost/model across all messages in the group
  const meta = extractGroupMeta(group, opts.contextWindow ?? null);

  return html`
    <div class="chat-group ${roleClass}">
      ${renderAvatar(
        group.role,
        {
          name: assistantName,
          avatar: opts.assistantAvatar ?? null,
        },
        opts.basePath,
      )}
      <div class="chat-group-messages">
        ${group.messages.map((item, index) =>
          renderGroupedMessage(
            item.message,
            {
              isStreaming: group.isStreaming && index === group.messages.length - 1,
              showReasoning: opts.showReasoning,
              showToolCalls: opts.showToolCalls ?? true,
            },
            opts.onOpenSidebar,
          ),
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
          ${renderMessageMeta(meta)}
          ${normalizedRole === "assistant" && isTtsSupported() ? renderTtsButton(group) : nothing}
          ${
            opts.onDelete
              ? renderDeleteButton(opts.onDelete, normalizedRole === "user" ? "left" : "right")
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

// ── Per-message metadata (tokens, cost, model, context %) ──

type GroupMeta = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  model: string | null;
  contextPercent: number | null;
};

function extractGroupMeta(group: MessageGroup, contextWindow: number | null): GroupMeta | null {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let model: string | null = null;
  let hasUsage = false;

  for (const { message } of group.messages) {
    const m = message as Record<string, unknown>;
    if (m.role !== "assistant") {
      continue;
    }
    const usage = m.usage as Record<string, number> | undefined;
    if (usage) {
      hasUsage = true;
      input += usage.input ?? usage.inputTokens ?? 0;
      output += usage.output ?? usage.outputTokens ?? 0;
      cacheRead += usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
      cacheWrite += usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0;
    }
    const c = m.cost as Record<string, number> | undefined;
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
    contextWindow && input > 0 ? Math.min(Math.round((input / contextWindow) * 100), 100) : null;

  return { input, output, cacheRead, cacheWrite, cost, model, contextPercent };
}

/** Compact token count formatter (e.g. 128000 → "128k"). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}

function renderMessageMeta(meta: GroupMeta | null) {
  if (!meta) {
    return nothing;
  }

  const parts: Array<ReturnType<typeof html>> = [];

  // Token counts: ↑input ↓output
  if (meta.input) {
    parts.push(html`<span class="msg-meta__tokens">↑${fmtTokens(meta.input)}</span>`);
  }
  if (meta.output) {
    parts.push(html`<span class="msg-meta__tokens">↓${fmtTokens(meta.output)}</span>`);
  }

  // Cache: R/W
  if (meta.cacheRead) {
    parts.push(html`<span class="msg-meta__cache">R${fmtTokens(meta.cacheRead)}</span>`);
  }
  if (meta.cacheWrite) {
    parts.push(html`<span class="msg-meta__cache">W${fmtTokens(meta.cacheWrite)}</span>`);
  }

  // Cost
  if (meta.cost > 0) {
    parts.push(html`<span class="msg-meta__cost">$${meta.cost.toFixed(4)}</span>`);
  }

  // Context %
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

  // Model
  if (meta.model) {
    // Shorten model name: strip provider prefix if present (e.g. "anthropic/claude-3.5-sonnet" → "claude-3.5-sonnet")
    const shortModel = meta.model.includes("/") ? meta.model.split("/").pop()! : meta.model;
    parts.push(html`<span class="msg-meta__model">${shortModel}</span>`);
  }

  if (parts.length === 0) {
    return nothing;
  }

  return html`<span class="msg-meta">${parts}</span>`;
}

function extractGroupText(group: MessageGroup): string {
  const parts: string[] = [];
  for (const { message } of group.messages) {
    const text = extractTextCached(message);
    if (text?.trim()) {
      parts.push(text.trim());
    }
  }
  return parts.join("\n\n");
}

const SKIP_DELETE_CONFIRM_KEY = "openclaw:skipDeleteConfirm";

type DeleteConfirmSide = "left" | "right";

function shouldSkipDeleteConfirm(): boolean {
  try {
    return getSafeLocalStorage()?.getItem(SKIP_DELETE_CONFIRM_KEY) === "1";
  } catch {
    return false;
  }
}

function renderDeleteButton(onDelete: () => void, side: DeleteConfirmSide) {
  return html`
    <span class="chat-delete-wrap">
      <button
        class="chat-group-delete"
        title="Delete"
        aria-label="Delete message"
        @click=${(e: Event) => {
          if (shouldSkipDeleteConfirm()) {
            onDelete();
            return;
          }
          const btn = e.currentTarget as HTMLElement;
          const wrap = btn.closest(".chat-delete-wrap") as HTMLElement;
          const existing = wrap?.querySelector(".chat-delete-confirm");
          if (existing) {
            existing.remove();
            return;
          }
          const popover = document.createElement("div");
          popover.className = `chat-delete-confirm chat-delete-confirm--${side}`;
          popover.innerHTML = `
            <p class="chat-delete-confirm__text">Delete this message?</p>
            <label class="chat-delete-confirm__remember">
              <input type="checkbox" class="chat-delete-confirm__check" />
              <span>Don't ask again</span>
            </label>
            <div class="chat-delete-confirm__actions">
              <button class="chat-delete-confirm__cancel" type="button">Cancel</button>
              <button class="chat-delete-confirm__yes" type="button">Delete</button>
            </div>
          `;
          wrap.appendChild(popover);

          const cancel = popover.querySelector(".chat-delete-confirm__cancel")!;
          const yes = popover.querySelector(".chat-delete-confirm__yes")!;
          const check = popover.querySelector(".chat-delete-confirm__check") as HTMLInputElement;

          cancel.addEventListener("click", () => popover.remove());
          yes.addEventListener("click", () => {
            if (check.checked) {
              try {
                getSafeLocalStorage()?.setItem(SKIP_DELETE_CONFIRM_KEY, "1");
              } catch {}
            }
            popover.remove();
            onDelete();
          });

          // Close on click outside
          const closeOnOutside = (evt: MouseEvent) => {
            if (!popover.contains(evt.target as Node) && evt.target !== btn) {
              popover.remove();
              document.removeEventListener("click", closeOnOutside, true);
            }
          };
          requestAnimationFrame(() => document.addEventListener("click", closeOnOutside, true));
        }}
      >${icons.trash ?? icons.x}</button>
    </span>
  `;
}

function renderTtsButton(group: MessageGroup) {
  return html`
    <button
      class="chat-tts-btn"
      type="button"
      title=${isTtsSpeaking() ? "Stop speaking" : "Read aloud"}
      aria-label=${isTtsSpeaking() ? "Stop speaking" : "Read aloud"}
      @click=${(e: Event) => {
        const btn = e.currentTarget as HTMLButtonElement;
        if (isTtsSpeaking()) {
          stopTts();
          btn.classList.remove("chat-tts-btn--active");
          btn.title = "Read aloud";
          return;
        }
        const text = extractGroupText(group);
        if (!text) {
          return;
        }
        btn.classList.add("chat-tts-btn--active");
        btn.title = "Stop speaking";
        speakText(text, {
          onEnd: () => {
            if (btn.isConnected) {
              btn.classList.remove("chat-tts-btn--active");
              btn.title = "Read aloud";
            }
          },
          onError: () => {
            if (btn.isConnected) {
              btn.classList.remove("chat-tts-btn--active");
              btn.title = "Read aloud";
            }
          },
        });
      }}
    >
      ${icons.volume2}
    </button>
  `;
}

function renderAvatar(
  role: string,
  assistant?: Pick<AssistantIdentity, "name" | "avatar">,
  basePath?: string,
) {
  const normalized = normalizeRoleForGrouping(role);
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const initial =
    normalized === "user"
      ? html`
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <circle cx="12" cy="8" r="4" />
            <path d="M20 21a8 8 0 1 0-16 0" />
          </svg>
        `
      : normalized === "assistant"
        ? html`
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
              <path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2L8 14 2 9.2h7.6z" />
            </svg>
          `
        : normalized === "tool"
          ? html`
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path
                  d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53a7.76 7.76 0 0 0 .07-1 7.76 7.76 0 0 0-.07-.97l2.11-1.63a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.15 7.15 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65a7.15 7.15 0 0 0-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64L4.57 11a7.9 7.9 0 0 0 0 1.94l-2.11 1.69a.49.49 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.72 1.69.98l.38 2.65c.05.24.26.42.49.42h4c.23 0 .44-.18.49-.42l.38-2.65a7.15 7.15 0 0 0 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.49.49 0 0 0-.12-.64z"
                />
              </svg>
            `
          : html`
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <circle cx="12" cy="12" r="10" />
                <text
                  x="12"
                  y="16.5"
                  text-anchor="middle"
                  font-size="14"
                  font-weight="600"
                  fill="var(--bg, #fff)"
                >
                  ?
                </text>
              </svg>
            `;
  const className =
    normalized === "user"
      ? "user"
      : normalized === "assistant"
        ? "assistant"
        : normalized === "tool"
          ? "tool"
          : "other";

  if (assistantAvatar && normalized === "assistant") {
    if (isAvatarUrl(assistantAvatar)) {
      return html`<img
        class="chat-avatar ${className}"
        src="${assistantAvatar}"
        alt="${assistantName}"
      />`;
    }
    return html`<img
      class="chat-avatar ${className} chat-avatar--logo"
      src="${agentLogoUrl(basePath ?? "")}"
      alt="${assistantName}"
    />`;
  }

  /* Assistant with no custom avatar: use logo when basePath available */
  if (normalized === "assistant" && basePath) {
    const logoUrl = agentLogoUrl(basePath);
    return html`<img
      class="chat-avatar ${className} chat-avatar--logo"
      src="${logoUrl}"
      alt="${assistantName}"
    />`;
  }

  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

function isAvatarUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) || /^data:image\//i.test(value) || value.startsWith("/") // Relative paths from avatar endpoint
  );
}

function renderMessageImages(images: ImageBlock[]) {
  if (images.length === 0) {
    return nothing;
  }

  const openImage = (url: string) => {
    openExternalUrlSafe(url, { allowDataImage: true });
  };

  return html`
    <div class="chat-message-images">
      ${images.map(
        (img) => html`
          <img
            src=${img.url}
            alt=${img.alt ?? "Attached image"}
            class="chat-message-image"
            @click=${() => openImage(img.url)}
          />
        `,
      )}
    </div>
  `;
}

/** Render tool cards inside a collapsed `<details>` element. */
function renderCollapsedToolCards(
  toolCards: ToolCard[],
  onOpenSidebar?: (content: string) => void,
) {
  const calls = toolCards.filter((c) => c.kind === "call");
  const results = toolCards.filter((c) => c.kind === "result");
  const totalTools = Math.max(calls.length, results.length) || toolCards.length;
  const toolNames = [...new Set(toolCards.map((c) => c.name))];
  const summaryLabel =
    toolNames.length <= 3
      ? toolNames.join(", ")
      : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;

  return html`
    <details class="chat-tools-collapse">
      <summary class="chat-tools-summary">
        <span class="chat-tools-summary__icon">${icons.zap}</span>
        <span class="chat-tools-summary__count">${totalTools} tool${totalTools === 1 ? "" : "s"}</span>
        <span class="chat-tools-summary__names">${summaryLabel}</span>
      </summary>
      <div class="chat-tools-collapse__body">
        ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
      </div>
    </details>
  `;
}

/**
 * Max characters for auto-detecting and pretty-printing JSON.
 * Prevents DoS from large JSON payloads in assistant/tool messages.
 */
const MAX_JSON_AUTOPARSE_CHARS = 20_000;

/**
 * Detect whether a trimmed string is a JSON object or array.
 * Must start with `{`/`[` and end with `}`/`]` and parse successfully.
 * Size-capped to prevent render-loop DoS from large JSON messages.
 */
function detectJson(text: string): { parsed: unknown; pretty: string } | null {
  const t = text.trim();

  // Enforce size cap to prevent UI freeze from multi-MB JSON payloads
  if (t.length > MAX_JSON_AUTOPARSE_CHARS) {
    return null;
  }

  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      const parsed = JSON.parse(t);
      return { parsed, pretty: JSON.stringify(parsed, null, 2) };
    } catch {
      return null;
    }
  }
  return null;
}

/** Build a short summary label for collapsed JSON (type + key count or array length). */
function jsonSummaryLabel(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    return `Array (${parsed.length} item${parsed.length === 1 ? "" : "s"})`;
  }
  if (parsed && typeof parsed === "object") {
    const keys = Object.keys(parsed as Record<string, unknown>);
    if (keys.length <= 4) {
      return `{ ${keys.join(", ")} }`;
    }
    return `Object (${keys.length} keys)`;
  }
  return "JSON";
}

function renderExpandButton(markdown: string, onOpenSidebar: (content: string) => void) {
  return html`
    <button
      class="chat-expand-btn"
      type="button"
      title="Open in canvas"
      aria-label="Open in canvas"
      @click=${() => onOpenSidebar(markdown)}
    >
      <span class="chat-expand-btn__icon" aria-hidden="true">${icons.panelRightOpen}</span>
    </button>
  `;
}

function renderGroupedMessage(
  message: unknown,
  opts: { isStreaming: boolean; showReasoning: boolean; showToolCalls?: boolean },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const normalizedRole = normalizeRoleForGrouping(role);
  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  const toolCards = (opts.showToolCalls ?? true) ? extractToolCards(message) : [];
  const hasToolCards = toolCards.length > 0;
  const images = extractImages(message);
  const hasImages = images.length > 0;

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking ? formatReasoningMarkdown(extractedThinking) : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());
  const canExpand = role === "assistant" && Boolean(onOpenSidebar && markdown?.trim());

  // Detect pure-JSON messages and render as collapsible block
  const jsonResult = markdown && !opts.isStreaming ? detectJson(markdown) : null;

  const bubbleClasses = ["chat-bubble", opts.isStreaming ? "streaming" : "", "fade-in"]
    .filter(Boolean)
    .join(" ");

  if (!markdown && !hasImages && hasToolCards && isToolResult) {
    return renderCollapsedToolCards(toolCards, onOpenSidebar);
  }

  // Suppress empty bubbles when tool cards are the only content and toggle is off
  const visibleToolCards = hasToolCards && (opts.showToolCalls ?? true);
  if (!markdown && !visibleToolCards && !hasImages) {
    return nothing;
  }

  const isToolMessage = normalizedRole === "tool" || isToolResult;
  const toolNames = [...new Set(toolCards.map((c) => c.name))];
  const toolSummaryLabel =
    toolNames.length <= 3
      ? toolNames.join(", ")
      : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;
  const toolPreview =
    markdown && !toolSummaryLabel ? markdown.trim().replace(/\s+/g, " ").slice(0, 120) : "";

  const hasActions = canCopyMarkdown || canExpand;

  return html`
    <div class="${bubbleClasses}">
      ${
        hasActions
          ? html`<div class="chat-bubble-actions">
              ${canExpand ? renderExpandButton(markdown!, onOpenSidebar!) : nothing}
              ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
            </div>`
          : nothing
      }
      ${
        isToolMessage
          ? html`
              ${renderMessageImages(images)}
            <details class="chat-tool-msg-collapse">
              <summary class="chat-tool-msg-summary">
                <span class="chat-tool-msg-summary__icon">${icons.zap}</span>
                <span class="chat-tool-msg-summary__label">Tool output</span>
                ${
                  toolSummaryLabel
                    ? html`<span class="chat-tool-msg-summary__names">${toolSummaryLabel}</span>`
                    : toolPreview
                      ? html`<span class="chat-tool-msg-summary__preview">${toolPreview}</span>`
                      : nothing
                }
              </summary>
              <div class="chat-tool-msg-body">
                ${
                  reasoningMarkdown
                    ? html`<div class="chat-thinking">${unsafeHTML(
                        toSanitizedMarkdownHtml(reasoningMarkdown),
                      )}</div>`
                    : nothing
                }
                ${
                  jsonResult
                    ? html`<details class="chat-json-collapse">
                        <summary class="chat-json-summary">
                          <span class="chat-json-badge">JSON</span>
                          <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
                        </summary>
                        <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
                      </details>`
                    : markdown
                      ? html`<div class="chat-text" dir="${detectTextDirection(markdown)}">${unsafeHTML(toSanitizedMarkdownHtml(markdown))}</div>`
                      : nothing
                }
                ${hasToolCards ? renderCollapsedToolCards(toolCards, onOpenSidebar) : nothing}
              </div>
            </details>
          `
          : html`
            ${renderMessageImages(images)}
            ${
              reasoningMarkdown
                ? html`<div class="chat-thinking">${unsafeHTML(
                    toSanitizedMarkdownHtml(reasoningMarkdown),
                  )}</div>`
                : nothing
            }
            ${
              jsonResult
                ? html`<details class="chat-json-collapse">
                    <summary class="chat-json-summary">
                      <span class="chat-json-badge">JSON</span>
                      <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
                    </summary>
                    <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
                  </details>`
                : markdown
                  ? html`<div class="chat-text" dir="${detectTextDirection(markdown)}">${unsafeHTML(toSanitizedMarkdownHtml(markdown))}</div>`
                  : nothing
            }
            ${hasToolCards ? renderCollapsedToolCards(toolCards, onOpenSidebar) : nothing}
          `
      }
    </div>
  `;
}
