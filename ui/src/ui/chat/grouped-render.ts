import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import type { AssistantIdentity } from "../assistant-identity";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { MessageGroup } from "../types/chat-types";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown";
import { isToolResultMessage, normalizeRoleForGrouping } from "./message-normalizer";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract";
import { extractToolCards, renderToolCardSidebar } from "./tool-cards";

type ImageBlock = {
  url: string;
  alt?: string;
};

function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        // Handle source object format (from sendChatMessage)
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          const data = source.data as string;
          const mediaType = (source.media_type as string) || "image/png";
          // If data is already a data URL, use it directly
          const url = data.startsWith("data:")
            ? data
            : `data:${mediaType};base64,${data}`;
          images.push({ url });
        } else if (typeof b.url === "string") {
          images.push({ url: b.url });
        }
      } else if (b.type === "image_url") {
        // OpenAI format
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          images.push({ url: imageUrl.url });
        }
      }
    }
  }

  return images;
}

export function renderReadingIndicatorGroup(assistant?: AssistantIdentity) {
  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
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

export type StreamPhase = {
  type: "thinking" | "text";
  content: string;
};

export type StreamingGroupOptions = {
  phases?: StreamPhase[];
  thinking?: string | null;
  showReasoning?: boolean;
  startedAt: number;
};

export function renderStreamingGroup(
  text: string,
  opts: StreamingGroupOptions,
  onOpenSidebar?: (content: string) => void,
  assistant?: AssistantIdentity,
) {
  const timestamp = new Date(opts.startedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const name = assistant?.name ?? "Assistant";
  const showReasoning = opts.showReasoning ?? false;

  // Build content array - prefer phases if available for proper visual separation
  const content: Array<{ type: string; thinking?: string; text?: string }> = [];
  if (opts.phases && opts.phases.length > 0) {
    // Use phase-aware rendering
    for (const phase of opts.phases) {
      if (phase.type === "thinking" && showReasoning) {
        content.push({ type: "thinking", thinking: phase.content });
      } else if (phase.type === "text") {
        content.push({ type: "text", text: phase.content });
      }
    }
  } else {
    // Fallback to legacy behavior
    if (opts.thinking && showReasoning) {
      content.push({ type: "thinking", thinking: opts.thinking });
    }
    if (text) {
      content.push({ type: "text", text });
    }
  }

  // If we have no content at all, show reading indicator
  if (content.length === 0) {
    return renderReadingIndicatorGroup(assistant);
  }

  return html`
    <div class="chat-group assistant">
      ${renderAvatar("assistant", assistant)}
      <div class="chat-group-messages">
        ${renderGroupedMessage(
          {
            role: "assistant",
            content,
            timestamp: opts.startedAt,
          },
          { isStreaming: true, showReasoning },
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
    assistantName?: string;
    assistantAvatar?: string | null;
  },
) {
  const normalizedRole = normalizeRoleForGrouping(group.role);
  const assistantName = opts.assistantName ?? "Assistant";
  const who =
    normalizedRole === "user"
      ? "You"
      : normalizedRole === "assistant"
        ? assistantName
        : normalizedRole;
  const roleClass =
    normalizedRole === "user"
      ? "user"
      : normalizedRole === "assistant"
        ? "assistant"
        : "other";
  const timestamp = new Date(group.timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  return html`
    <div class="chat-group ${roleClass}">
      ${renderAvatar(group.role, {
        name: assistantName,
        avatar: opts.assistantAvatar ?? null,
      })}
      <div class="chat-group-messages">
        ${group.messages.map((item, index) =>
          renderGroupedMessage(
            item.message,
            {
              isStreaming:
                group.isStreaming && index === group.messages.length - 1,
              showReasoning: opts.showReasoning,
            },
            opts.onOpenSidebar,
          ),
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
        </div>
      </div>
    </div>
  `;
}

function renderAvatar(
  role: string,
  assistant?: Pick<AssistantIdentity, "name" | "avatar">,
) {
  const normalized = normalizeRoleForGrouping(role);
  const assistantName = assistant?.name?.trim() || "Assistant";
  const assistantAvatar = assistant?.avatar?.trim() || "";
  const initial =
    normalized === "user"
      ? "U"
      : normalized === "assistant"
        ? assistantName.charAt(0).toUpperCase() || "A"
        : normalized === "tool"
          ? "⚙"
          : "?";
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
    return html`<div class="chat-avatar ${className}">${assistantAvatar}</div>`;
  }

  return html`<div class="chat-avatar ${className}">${initial}</div>`;
}

function isAvatarUrl(value: string): boolean {
  return (
    /^https?:\/\//i.test(value) ||
    /^data:image\//i.test(value) ||
    /^\//.test(value) // Relative paths from avatar endpoint
  );
}

function renderMessageImages(images: ImageBlock[]) {
  if (images.length === 0) return nothing;

  return html`
    <div class="chat-message-images">
      ${images.map(
        (img) => html`
          <img
            src=${img.url}
            alt=${img.alt ?? "Attached image"}
            class="chat-message-image"
            @click=${() => window.open(img.url, "_blank")}
          />
        `,
      )}
    </div>
  `;
}

function hasMultiplePhaseTypes(content: unknown[]): boolean {
  let hasThinking = false;
  let hasText = false;
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as { type?: string };
    if (c.type === "thinking") hasThinking = true;
    if (c.type === "text") hasText = true;
    if (hasThinking && hasText) return true;
  }
  return false;
}

function renderPhaseContent(
  content: unknown[],
  opts: { showReasoning: boolean },
) {
  // Check if we have multiple phase types for visual separation
  const usePhaseClasses = hasMultiplePhaseTypes(content);

  return content.map((item) => {
    if (typeof item !== "object" || item === null) return nothing;
    const c = item as { type?: string; thinking?: string; text?: string };

    if (c.type === "thinking" && typeof c.thinking === "string" && opts.showReasoning) {
      const reasoningMarkdown = formatReasoningMarkdown(c.thinking);
      const className = usePhaseClasses ? "chat-thinking-phase" : "chat-thinking";
      return html`<div class="${className}">${unsafeHTML(
        toSanitizedMarkdownHtml(reasoningMarkdown),
      )}</div>`;
    }

    if (c.type === "text" && typeof c.text === "string") {
      const className = usePhaseClasses ? "chat-text-phase" : "chat-text";
      return html`<div class="${className}">${unsafeHTML(toSanitizedMarkdownHtml(c.text))}</div>`;
    }

    return nothing;
  });
}

function renderGroupedMessage(
  message: unknown,
  opts: { isStreaming: boolean; showReasoning: boolean },
  onOpenSidebar?: (content: string) => void,
) {
  const m = message as Record<string, unknown>;
  const role = typeof m.role === "string" ? m.role : "unknown";
  const isToolResult =
    isToolResultMessage(message) ||
    role.toLowerCase() === "toolresult" ||
    role.toLowerCase() === "tool_result" ||
    typeof m.toolCallId === "string" ||
    typeof m.tool_call_id === "string";

  const toolCards = extractToolCards(message);
  const hasToolCards = toolCards.length > 0;
  const images = extractImages(message);
  const hasImages = images.length > 0;

  // Check if content is already phase-structured (for streaming)
  const content = m.content;
  const isPhaseStructured =
    Array.isArray(content) &&
    content.length > 0 &&
    content.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        ((item as { type?: string }).type === "thinking" ||
          (item as { type?: string }).type === "text"),
    );

  const extractedText = extractTextCached(message);
  const extractedThinking =
    opts.showReasoning && role === "assistant"
      ? extractThinkingCached(message)
      : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking
    ? formatReasoningMarkdown(extractedThinking)
    : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());

  const bubbleClasses = [
    "chat-bubble",
    canCopyMarkdown ? "has-copy" : "",
    opts.isStreaming ? "streaming" : "",
    "fade-in",
  ]
    .filter(Boolean)
    .join(" ");

  if (!markdown && hasToolCards && isToolResult) {
    return html`${toolCards.map((card) =>
      renderToolCardSidebar(card, onOpenSidebar),
    )}`;
  }

  if (!markdown && !hasToolCards && !hasImages) return nothing;

  // Use phase-aware rendering when content is structured with phases
  if (isPhaseStructured && Array.isArray(content)) {
    return html`
      <div class="${bubbleClasses}">
        ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
        ${renderMessageImages(images)}
        ${renderPhaseContent(content, { showReasoning: opts.showReasoning })}
        ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
      </div>
    `;
  }

  // Fallback to legacy rendering
  return html`
    <div class="${bubbleClasses}">
      ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
      ${renderMessageImages(images)}
      ${reasoningMarkdown
        ? html`<div class="chat-thinking">${unsafeHTML(
            toSanitizedMarkdownHtml(reasoningMarkdown),
          )}</div>`
        : nothing}
      ${markdown
        ? html`<div class="chat-text">${unsafeHTML(toSanitizedMarkdownHtml(markdown))}</div>`
        : nothing}
      ${toolCards.map((card) => renderToolCardSidebar(card, onOpenSidebar))}
    </div>
  `;
}
