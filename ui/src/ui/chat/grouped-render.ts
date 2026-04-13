import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { AssistantIdentity } from "../assistant-identity.ts";
import type { EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import type { SidebarContent } from "../sidebar-content.ts";
import { detectTextDirection } from "../text-direction.ts";
import type {
  MessageContentItem,
  MessageGroup,
  NormalizedMessage,
  ToolCard,
} from "../types/chat-types.ts";
import { agentLogoUrl } from "../views/agents-utils.ts";
import { renderCopyAsMarkdownButton } from "./copy-as-markdown.ts";
import {
  extractTextCached,
  extractThinkingCached,
  formatReasoningMarkdown,
} from "./message-extract.ts";
import {
  isToolResultMessage,
  normalizeMessage,
  normalizeRoleForGrouping,
} from "./message-normalizer.ts";
import { setupResizeHandles, getStoredMessageSize } from "./message-resize.ts";
import { isTtsSupported, speakText, stopTts, isTtsSpeaking } from "./speech.ts";
import {
  extractToolCards,
  renderExpandedToolCardContent,
  renderRawOutputToggle,
  renderToolCard,
  renderToolPreview,
} from "./tool-cards.ts";

type AssistantAttachmentAvailability =
  | { status: "checking" }
  | { status: "available" }
  | { status: "unavailable"; reason: string; checkedAt: number };

const assistantAttachmentAvailabilityCache = new Map<string, AssistantAttachmentAvailability>();
const ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS = 5_000;

export function resetAssistantAttachmentAvailabilityCacheForTest() {
  assistantAttachmentAvailabilityCache.clear();
}

type ImageBlock = {
  url: string;
  alt?: string;
  filename?: string;
  httpUrl?: string;
};

type AudioBlock = {
  type: "audio";
  data: string;
  mimeType: string;
  filename?: string;
};

type VideoBlock = {
  type: "video";
  data: string;
  mimeType: string;
  filename?: string;
};

const DETAILS_STATE_KEY = "chat:details_state";

function saveDetailsState(id: string, isOpen: boolean) {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    const state = JSON.parse(storage.getItem(DETAILS_STATE_KEY) || "{}");
    state[id] = isOpen;
    storage.setItem(DETAILS_STATE_KEY, JSON.stringify(state));
  } catch {}
}

function getDetailsState(id: string): boolean {
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return true;
    }
    const state = JSON.parse(storage.getItem(DETAILS_STATE_KEY) || "{}");
    if (state[id] === undefined) {
      return true;
    }
    return state[id] === true;
  } catch {
    return true;
  }
}

function generateDetailsId(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const id = m.id || m.messageId || m.timestamp;
  // Convert id to string safely
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  const idString = id ? (typeof id === "object" ? JSON.stringify(id) : String(id)) : "unknown";
  return `tool-${idString}-${index}`;
}

function extractImages(message: unknown): ImageBlock[] {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const images: ImageBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== "object" || block === null) {
        continue;
      }
      const b = block as Record<string, unknown>;

      if (b.type === "image") {
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === "base64" && typeof source.data === "string") {
          const mediaType = (source.media_type as string) || "image/png";
          const raw = source.data;
          const url = raw.startsWith("data:") ? raw : `data:${mediaType};base64,${raw}`;
          const filename = typeof b.filename === "string" ? b.filename : undefined;
          images.push({ url, filename, httpUrl: undefined });
        } else if (typeof b.url === "string") {
          const u = b.url;
          const isMediaServerUrl =
            u.startsWith("http://localhost:18791/") || u.startsWith("http://127.0.0.1:18791/");
          const httpUrl = isMediaServerUrl ? u : undefined;
          const filename = typeof b.filename === "string" ? b.filename : u.split("/").pop();
          images.push({ url: u, filename, httpUrl });
        }
      } else if (b.type === "image_url") {
        const imageUrl = b.image_url as Record<string, unknown> | undefined;
        if (typeof imageUrl?.url === "string") {
          const u = imageUrl.url;
          const isMediaServerUrl =
            u.startsWith("http://localhost:18791/") || u.startsWith("http://127.0.0.1:18791/");
          const httpUrl = isMediaServerUrl ? u : undefined;
          images.push({
            url: u,
            filename: u.split("/").pop(),
            httpUrl,
          });
        }
      }
    }
  }

  return images;
}

function extractAudioVideoBlocks(message: unknown): { audio: AudioBlock[]; video: VideoBlock[] } {
  const m = message as Record<string, unknown>;
  const content = m.content;
  const audio: AudioBlock[] = [];
  const video: VideoBlock[] = [];

  if (!Array.isArray(content)) {
    return { audio, video };
  }

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const b = block as Record<string, unknown>;

    if (b.type === "audio") {
      if (typeof b.url === "string") {
        audio.push({
          type: "audio",
          data: b.url,
          mimeType: typeof b.mimeType === "string" ? b.mimeType : "audio/ogg",
          filename: typeof b.filename === "string" ? b.filename : undefined,
        });
      } else if (typeof b.data === "string") {
        const mimeTypeValue = typeof b.mimeType === "string" ? b.mimeType : "audio/ogg";
        const dataUrl = b.data.startsWith("data:")
          ? b.data
          : `data:${mimeTypeValue};base64,${b.data}`;
        audio.push({
          type: "audio",
          data: dataUrl,
          mimeType: mimeTypeValue,
          filename: typeof b.filename === "string" ? b.filename : undefined,
        });
      }
    }

    if (b.type === "video") {
      if (typeof b.url === "string") {
        video.push({
          type: "video",
          data: b.url,
          mimeType: typeof b.mimeType === "string" ? b.mimeType : "video/mp4",
          filename: typeof b.filename === "string" ? b.filename : undefined,
        });
      } else if (typeof b.data === "string") {
        const mimeTypeValue = typeof b.mimeType === "string" ? b.mimeType : "video/mp4";
        const dataUrl = b.data.startsWith("data:")
          ? b.data
          : `data:${mimeTypeValue};base64,${b.data}`;
        video.push({
          type: "video",
          data: dataUrl,
          mimeType: mimeTypeValue,
          filename: typeof b.filename === "string" ? b.filename : undefined,
        });
      }
    }
  }

  return { audio, video };
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
  onOpenSidebar?: (content: SidebarContent) => void,
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
          `stream:${startedAt}`,
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
    onOpenSidebar?: (content: SidebarContent) => void;
    showReasoning: boolean;
    showToolCalls?: boolean;
    autoExpandToolCalls?: boolean;
    isToolMessageExpanded?: (messageId: string) => boolean;
    onToggleToolMessageExpanded?: (messageId: string) => void;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string) => void;
    onRequestUpdate?: () => void;
    assistantName?: string;
    assistantAvatar?: string | null;
    basePath?: string;
    localMediaPreviewRoots?: readonly string[];
    assistantAttachmentAuthToken?: string | null;
    canvasHostUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
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
            item.key,
            {
              isStreaming: group.isStreaming && index === group.messages.length - 1,
              showReasoning: opts.showReasoning,
              showToolCalls: opts.showToolCalls ?? true,
              autoExpandToolCalls: opts.autoExpandToolCalls ?? false,
              isToolMessageExpanded: opts.isToolMessageExpanded,
              onToggleToolMessageExpanded: opts.onToggleToolMessageExpanded,
              isToolExpanded: opts.isToolExpanded,
              onToggleToolExpanded: opts.onToggleToolExpanded,
              onRequestUpdate: opts.onRequestUpdate,
              canvasHostUrl: opts.canvasHostUrl,
              basePath: opts.basePath,
              localMediaPreviewRoots: opts.localMediaPreviewRoots,
              assistantAttachmentAuthToken: opts.assistantAttachmentAuthToken,
              embedSandboxMode: opts.embedSandboxMode,
            },
            opts.onOpenSidebar,
          ),
        )}
        <div class="chat-group-footer">
          <span class="chat-sender-name">${who}</span>
          <span class="chat-group-timestamp">${timestamp}</span>
          ${renderMessageMeta(meta)}
          ${normalizedRole === "assistant" && isTtsSupported() ? renderTtsButton(group) : nothing}
          ${opts.onDelete
            ? renderDeleteButton(opts.onDelete, normalizedRole === "user" ? "left" : "right")
            : nothing}
        </div>
      </div>
    </div>
  `;
}

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

  if (meta.input) {
    parts.push(html`<span class="msg-meta__tokens">↑${fmtTokens(meta.input)}</span>`);
  }
  if (meta.output) {
    parts.push(html`<span class="msg-meta__tokens">↓${fmtTokens(meta.output)}</span>`);
  }

  if (meta.cacheRead) {
    parts.push(html`<span class="msg-meta__cache">R${fmtTokens(meta.cacheRead)}</span>`);
  }
  if (meta.cacheWrite) {
    parts.push(html`<span class="msg-meta__cache">W${fmtTokens(meta.cacheWrite)}</span>`);
  }

  if (meta.cost > 0) {
    parts.push(html`<span class="msg-meta__cost">$${meta.cost.toFixed(4)}</span>`);
  }

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

  if (meta.model) {
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

          const closeOnOutside = (evt: MouseEvent) => {
            if (!popover.contains(evt.target as Node) && evt.target !== btn) {
              popover.remove();
              document.removeEventListener("click", closeOnOutside, true);
            }
          };
          requestAnimationFrame(() => document.addEventListener("click", closeOnOutside, true));
        }}
      >
        ${icons.trash ?? icons.x}
      </button>
    </span>
  `;
}

function renderTtsButton(group: MessageGroup) {
  return html`
    <button
      class="btn btn--xs chat-tts-btn"
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
  return /^https?:\/\//i.test(value) || /^data:image\//i.test(value) || value.startsWith("/");
}

function renderMessageImages(images: ImageBlock[]) {
  if (images.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-message-images">
      ${images.map(
        (img) => html`
          <div class="chat-image-wrapper">
            <img
              src=${img.url}
              alt=${img.alt ?? "Attached image"}
              class="chat-message-image"
              @load=${(e: Event) => {
                const imgEl = e.target as HTMLImageElement;
                const naturalWidth = imgEl.naturalWidth;

                const bubble = imgEl.closest(".chat-bubble") as HTMLElement;
                if (bubble && !bubble.style.width) {
                  let targetWidth: number;

                  if (naturalWidth >= 3840) {
                    targetWidth = 400;
                  } else if (naturalWidth >= 2560) {
                    targetWidth = 380;
                  } else if (naturalWidth >= 1920) {
                    targetWidth = 360;
                  } else if (naturalWidth >= 1280) {
                    targetWidth = 340;
                  } else if (naturalWidth >= 800) {
                    targetWidth = 320;
                  } else if (naturalWidth >= 500) {
                    targetWidth = 300;
                  } else {
                    targetWidth = Math.floor(naturalWidth * 0.8);
                  }

                  bubble.style.width = `${targetWidth}px`;
                }
              }}
            />
            ${img.httpUrl && img.httpUrl.startsWith("http")
              ? html`<a
                  href=${img.httpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="chat-image-filename"
                  title="Open full-size image"
                  style="display: block; text-align: center; width: 100%;"
                  >${img.filename ?? "Open Image"}</a
                >`
              : nothing}
          </div>
        `,
      )}
    </div>
  `;
}

function renderMessageMedia(audioBlocks: AudioBlock[], videoBlocks: VideoBlock[]) {
  const elements = [];

  for (let i = 0; i < audioBlocks.length; i++) {
    const audio = audioBlocks[i];
    // Add error handler to hide the "Unavailable" message
    const handleError = (e: Event) => {
      const audioEl = e.target as HTMLAudioElement;
      const wrapper = audioEl.closest(".chat-media-wrapper");
      if (wrapper) {
        // Hide the entire audio player on error
        (wrapper as HTMLElement).style.display = "none";
      }
    };

    elements.push(html`
      <div class="chat-media-wrapper">
        <audio controls class="chat-message-audio" @error=${handleError}>
          <source src=${audio.data} type=${audio.mimeType} />
          Your browser does not support the audio element.
        </audio>
        <div class="chat-media-filename">${audio.filename || audio.mimeType}</div>
      </div>
    `);
  }

  for (let i = 0; i < videoBlocks.length; i++) {
    const video = videoBlocks[i];
    const handleError = (e: Event) => {
      const videoEl = e.target as HTMLVideoElement;
      const wrapper = videoEl.closest(".chat-media-wrapper");
      if (wrapper) {
        (wrapper as HTMLElement).style.display = "none";
      }
    };

    elements.push(html`
      <div class="chat-media-wrapper" style="width: 100%; max-width: 640px;">
        <video
          controls
          class="chat-message-video"
          style="width: 100%; max-width: 640px; height: auto; max-height: 360px;"
          playsinline
          @error=${handleError}
        >
          <source src=${video.data} type=${video.mimeType} />
          Your browser does not support the video element.
        </video>
        <div class="chat-media-filename">${video.filename || video.mimeType}</div>
      </div>
    `);
  }

  if (elements.length === 0) {
    return nothing;
  }

  return html`<div class="chat-message-media" style="width: 100%;">${elements}</div>`;
}

function renderVideoEmbed(markdown: string) {
  const watchMatch = markdown.match(/https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]+)/);
  if (watchMatch) {
    const embedUrl = `https://www.youtube.com/embed/${watchMatch[1]}`;
    return html`
      <div class="video-embed-container">
        <iframe
          src=${embedUrl}
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="no-referrer-when-downgrade"
          allowfullscreen
          class="video-embed-frame"
        ></iframe>
      </div>
    `;
  }

  const youtubeMatch = markdown.match(
    /https?:\/\/(?:www\.)?(?:youtube\.com\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]+)/,
  );
  if (youtubeMatch) {
    const embedUrl = `https://www.youtube.com/embed/${youtubeMatch[1]}`;
    return html`
      <div class="video-embed-container">
        <iframe
          src=${embedUrl}
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="no-referrer-when-downgrade"
          allowfullscreen
          class="video-embed-frame"
        ></iframe>
      </div>
    `;
  }

  const vimeoMatch = markdown.match(/https?:\/\/(?:www\.)?player\.vimeo\.com\/video\/(\d+)/);
  if (vimeoMatch) {
    const embedUrl = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    return html`
      <div class="video-embed-container">
        <iframe
          src=${embedUrl}
          frameborder="0"
          allow="autoplay; fullscreen; picture-in-picture"
          allowfullscreen
          class="video-embed-frame"
        ></iframe>
      </div>
    `;
  }

  return nothing;
}

function renderCollapsedToolCards(
  toolCards: ToolCard[],
  onOpenSidebar?: (content: SidebarContent) => void,
) {
  const totalTools = toolCards.length;
  const toolNames = [...new Set(toolCards.map((c) => c.name))];
  const summaryLabel =
    toolNames.length <= 3
      ? toolNames.join(", ")
      : `${toolNames.slice(0, 2).join(", ")} +${toolNames.length - 2} more`;

  return html`
    <details class="chat-tools-collapse">
      <summary class="chat-tools-summary">
        <span class="chat-tools-summary__icon">${icons.zap}</span>
        <span class="chat-tools-summary__count"
          >${totalTools} tool${totalTools === 1 ? "" : "s"}</span
        >
        <span class="chat-tools-summary__names">${summaryLabel}</span>
      </summary>
      <div class="chat-tools-collapse__body">
        ${toolCards.map((card) =>
          renderToolCard(card, {
            expanded: false,
            onToggleExpanded: () => {},
            onOpenSidebar,
            canvasHostUrl: null,
            embedSandboxMode: "scripts",
            allowExternalEmbedUrls: false,
          }),
        )}
      </div>
    </details>
  `;
}

function renderReplyPill(replyTarget: NormalizedMessage["replyTarget"]) {
  if (!replyTarget) {
    return nothing;
  }
  return html`
    <div class="chat-reply-pill">
      <span class="chat-reply-pill__icon">${icons.messageSquare}</span>
      <span class="chat-reply-pill__label">
        ${replyTarget.kind === "current"
          ? "Replying to current message"
          : `Replying to ${replyTarget.id}`}
      </span>
    </div>
  `;
}

function isLocalAssistantAttachmentSource(source: string): boolean {
  const trimmed = source.trim();
  if (/^\/(?:__openclaw__|media)\//.test(trimmed)) {
    return false;
  }
  return (
    trimmed.startsWith("file://") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

function normalizeLocalAttachmentPath(source: string): string | null {
  const trimmed = source.trim();
  if (!isLocalAssistantAttachmentSource(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      const pathname = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:\//.test(pathname)) {
        return pathname.slice(1);
      }
      return pathname;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("~")) {
    return null;
  }
  return trimmed;
}

function resolveHomeCandidatesFromRoots(localMediaPreviewRoots: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const root of localMediaPreviewRoots) {
    const normalized = canonicalizeLocalPathForComparison(root.trim());
    const unixHome = normalized.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/);
    if (unixHome?.[1]) {
      candidates.add(unixHome[1]);
      continue;
    }
    const windowsHome = normalized.match(/^([a-z]:\/Users\/[^/]+)(?:\/|$)/i);
    if (windowsHome?.[1]) {
      candidates.add(windowsHome[1]);
    }
  }
  return [...candidates];
}

function canonicalizeLocalPathForComparison(value: string): string {
  let slashNormalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^\/[a-zA-Z]:\//.test(slashNormalized)) {
    slashNormalized = slashNormalized.slice(1);
  }
  if (/^[a-zA-Z]:\//.test(slashNormalized)) {
    return slashNormalized.toLowerCase();
  }
  return slashNormalized;
}

function isLocalAttachmentPreviewAllowed(
  source: string,
  localMediaPreviewRoots: readonly string[],
): boolean {
  const normalizedSource = normalizeLocalAttachmentPath(source);
  const comparableSources = normalizedSource
    ? [canonicalizeLocalPathForComparison(normalizedSource)]
    : source.trim().startsWith("~")
      ? resolveHomeCandidatesFromRoots(localMediaPreviewRoots).map((home) =>
          canonicalizeLocalPathForComparison(source.trim().replace(/^~(?=$|[\\/])/, home)),
        )
      : [];
  if (comparableSources.length === 0) {
    return false;
  }
  return localMediaPreviewRoots.some((root) => {
    const normalizedRoot = canonicalizeLocalPathForComparison(root.trim());
    return (
      normalizedRoot.length > 0 &&
      comparableSources.some(
        (comparableSource) =>
          comparableSource === normalizedRoot || comparableSource.startsWith(`${normalizedRoot}/`),
      )
    );
  });
}

function buildAssistantAttachmentUrl(
  source: string,
  basePath?: string,
  authToken?: string | null,
): string {
  if (!isLocalAssistantAttachmentSource(source)) {
    return source;
  }
  const normalizedBasePath =
    basePath && basePath !== "/" ? (basePath.endsWith("/") ? basePath.slice(0, -1) : basePath) : "";
  const params = new URLSearchParams({ source });
  const normalizedToken = authToken?.trim();
  if (normalizedToken) {
    params.set("token", normalizedToken);
  }
  return `${normalizedBasePath}/__openclaw__/assistant-media?${params.toString()}`;
}

function buildAssistantAttachmentMetaUrl(
  source: string,
  basePath?: string,
  authToken?: string | null,
): string {
  const attachmentUrl = buildAssistantAttachmentUrl(source, basePath, authToken);
  return `${attachmentUrl}${attachmentUrl.includes("?") ? "&" : "?"}meta=1`;
}

function resolveAssistantAttachmentAvailability(
  source: string,
  localMediaPreviewRoots: readonly string[],
  basePath: string | undefined,
  authToken: string | null | undefined,
  onRequestUpdate: (() => void) | undefined,
): AssistantAttachmentAvailability {
  if (!isLocalAssistantAttachmentSource(source)) {
    return { status: "available" };
  }
  if (!isLocalAttachmentPreviewAllowed(source, localMediaPreviewRoots)) {
    return { status: "unavailable", reason: "Outside allowed folders", checkedAt: Date.now() };
  }
  const normalizedAuthToken = authToken?.trim() ?? "";
  const cacheKey = `${basePath ?? ""}::${normalizedAuthToken}::${source}`;
  const cached = assistantAttachmentAvailabilityCache.get(cacheKey);
  if (cached) {
    if (
      cached.status === "unavailable" &&
      Date.now() - cached.checkedAt >= ASSISTANT_ATTACHMENT_UNAVAILABLE_RETRY_MS
    ) {
      assistantAttachmentAvailabilityCache.delete(cacheKey);
    } else {
      return cached;
    }
  }
  assistantAttachmentAvailabilityCache.set(cacheKey, { status: "checking" });
  if (typeof fetch === "function") {
    void fetch(buildAssistantAttachmentMetaUrl(source, basePath, authToken), {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(async (res) => {
        const payload = (await res.json().catch(() => null)) as {
          available?: boolean;
          reason?: string;
        } | null;
        if (payload?.available === true) {
          assistantAttachmentAvailabilityCache.set(cacheKey, { status: "available" });
        } else {
          assistantAttachmentAvailabilityCache.set(cacheKey, {
            status: "unavailable",
            reason: payload?.reason?.trim() || "Attachment unavailable",
            checkedAt: Date.now(),
          });
        }
      })
      .catch(() => {
        assistantAttachmentAvailabilityCache.set(cacheKey, {
          status: "unavailable",
          reason: "Attachment unavailable",
          checkedAt: Date.now(),
        });
      })
      .finally(() => {
        onRequestUpdate?.();
      });
  }
  return { status: "checking" };
}

function renderAssistantAttachmentStatusCard(params: {
  kind: "image" | "audio" | "video" | "document";
  label: string;
  badge: string;
  reason?: string;
}) {
  const icon =
    params.kind === "image"
      ? icons.image
      : params.kind === "audio"
        ? icons.mic
        : params.kind === "video"
          ? icons.monitor
          : icons.paperclip;
  return html`
    <div class="chat-assistant-attachment-card chat-assistant-attachment-card--blocked">
      <div class="chat-assistant-attachment-card__header">
        <span class="chat-assistant-attachment-card__icon">${icon}</span>
        <span class="chat-assistant-attachment-card__title">${params.label}</span>
        <span class="chat-assistant-attachment-badge chat-assistant-attachment-badge--muted"
          >${params.badge}</span
        >
      </div>
      ${params.reason
        ? html`<div class="chat-assistant-attachment-card__reason">${params.reason}</div>`
        : nothing}
    </div>
  `;
}

function renderAssistantAttachments(
  attachments: Array<Extract<MessageContentItem, { type: "attachment" }>>,
  localMediaPreviewRoots: readonly string[],
  basePath?: string,
  authToken?: string | null,
  onRequestUpdate?: () => void,
) {
  if (attachments.length === 0) {
    return nothing;
  }
  return html`
    <div class="chat-assistant-attachments">
      ${attachments.map(({ attachment }) => {
        // Skip audio - handled by audio player
        if (attachment.kind === "audio") {
          return nothing;
        }
        // Skip image - handled by renderMessageImages
        if (attachment.kind === "image") {
          return nothing;
        }

        const availability = resolveAssistantAttachmentAvailability(
          attachment.url,
          localMediaPreviewRoots,
          basePath,
          authToken,
          onRequestUpdate,
        );
        const attachmentUrl =
          availability.status === "available"
            ? buildAssistantAttachmentUrl(attachment.url, basePath, authToken)
            : null;
        if (attachment.kind === "video") {
          if (!attachmentUrl) {
            return renderAssistantAttachmentStatusCard({
              kind: "video",
              label: attachment.label,
              badge: availability.status === "checking" ? "Checking..." : "Unavailable",
              reason: availability.status === "unavailable" ? availability.reason : undefined,
            });
          }
          return html`
            <div class="chat-assistant-attachment-card chat-assistant-attachment-card--video">
              <video controls preload="metadata" src=${attachmentUrl}></video>
              <a
                class="chat-assistant-attachment-card__link"
                href=${attachmentUrl}
                target="_blank"
                rel="noreferrer"
                >${attachment.label}</a
              >
            </div>
          `;
        }
        if (!attachmentUrl) {
          return renderAssistantAttachmentStatusCard({
            kind: "document",
            label: attachment.label,
            badge: availability.status === "checking" ? "Checking..." : "Unavailable",
            reason: availability.status === "unavailable" ? availability.reason : undefined,
          });
        }
        return html`
          <div class="chat-assistant-attachment-card">
            <span class="chat-assistant-attachment-card__icon">${icons.paperclip}</span>
            <a
              class="chat-assistant-attachment-card__link"
              href=${attachmentUrl}
              target="_blank"
              rel="noreferrer"
              >${attachment.label}</a
            >
          </div>
        `;
      })}
    </div>
  `;
}

function renderInlineToolCards(
  toolCards: ToolCard[],
  opts: {
    messageKey: string;
    onOpenSidebar?: (content: SidebarContent) => void;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string) => void;
    canvasHostUrl?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
) {
  return html`
    <div class="chat-tools-inline">
      ${toolCards.map((card, index) =>
        renderToolCard(card, {
          expanded: opts.isToolExpanded?.(`${opts.messageKey}:toolcard:${index}`) ?? false,
          onToggleExpanded: opts.onToggleToolExpanded
            ? () => opts.onToggleToolExpanded?.(`${opts.messageKey}:toolcard:${index}`)
            : () => undefined,
          onOpenSidebar: opts.onOpenSidebar,
          canvasHostUrl: opts.canvasHostUrl,
          embedSandboxMode: opts.embedSandboxMode ?? "scripts",
          allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
        }),
      )}
    </div>
  `;
}

const MAX_JSON_AUTOPARSE_CHARS = 20_000;

function detectJson(text: string): { parsed: unknown; pretty: string } | null {
  const t = text.trim();

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

function renderExpandButton(markdown: string, onOpenSidebar: (content: SidebarContent) => void) {
  return html`
    <button
      class="btn btn--xs chat-expand-btn"
      type="button"
      title="Open in canvas"
      aria-label="Open in canvas"
      @click=${() => onOpenSidebar({ kind: "markdown", content: markdown })}
    >
      <span class="chat-expand-btn__icon" aria-hidden="true">${icons.panelRightOpen}</span>
    </button>
  `;
}

function renderGroupedMessage(
  message: unknown,
  messageKey: string,
  opts: {
    isStreaming: boolean;
    showReasoning: boolean;
    showToolCalls?: boolean;
    autoExpandToolCalls?: boolean;
    isToolMessageExpanded?: (messageId: string) => boolean;
    onToggleToolMessageExpanded?: (messageId: string) => void;
    isToolExpanded?: (toolCardId: string) => boolean;
    onToggleToolExpanded?: (toolCardId: string) => void;
    onRequestUpdate?: () => void;
    canvasHostUrl?: string | null;
    basePath?: string;
    localMediaPreviewRoots?: readonly string[];
    assistantAttachmentAuthToken?: string | null;
    embedSandboxMode?: EmbedSandboxMode;
    allowExternalEmbedUrls?: boolean;
  },
  onOpenSidebar?: (content: SidebarContent) => void,
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

  const toolCards = (opts.showToolCalls ?? true) ? extractToolCards(message, messageKey) : [];
  const hasToolCards = toolCards.length > 0;
  const images = extractImages(message);
  const { audio: audioBlocks, video: videoBlocks } = extractAudioVideoBlocks(message);
  const hasImages = images.length > 0;
  const hasMedia = audioBlocks.length > 0 || videoBlocks.length > 0 || hasImages;

  const normalizedMessage = normalizeMessage(message);
  const extractedText = normalizedMessage.content
    .reduce<string[]>((lines, item) => {
      if (item.type === "text" && typeof item.text === "string") {
        lines.push(item.text);
      }
      return lines;
    }, [])
    .join("\n")
    .trim();
  const assistantAttachments = normalizedMessage.content.filter(
    (item): item is Extract<MessageContentItem, { type: "attachment" }> =>
      item.type === "attachment",
  );
  const assistantViewBlocks = normalizedMessage.content.filter(
    (item): item is Extract<MessageContentItem, { type: "canvas" }> => item.type === "canvas",
  );
  const extractedThinking =
    opts.showReasoning && role === "assistant" ? extractThinkingCached(message) : null;
  const markdownBase = extractedText?.trim() ? extractedText : null;
  const reasoningMarkdown = extractedThinking ? formatReasoningMarkdown(extractedThinking) : null;
  const markdown = markdownBase;
  const canCopyMarkdown = role === "assistant" && Boolean(markdown?.trim());
  const canExpand = role === "assistant" && Boolean(onOpenSidebar && markdown?.trim());

  const jsonResult = markdown && !opts.isStreaming ? detectJson(markdown) : null;

  const isResizable =
    (role === "assistant" || role === "tool" || isToolResult) && !opts.isStreaming;
  const messageId = (m.id ||
    m.messageId ||
    m.timestamp?.toString() ||
    Date.now().toString()) as string;
  const storedSize = isResizable ? getStoredMessageSize(messageId) : null;
  const bubbleClasses = [
    "chat-bubble",
    opts.isStreaming ? "streaming" : "",
    "fade-in",
    isResizable ? "chat-bubble-resizable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (!markdown && hasToolCards && isToolResult && !hasMedia) {
    return renderCollapsedToolCards(toolCards, onOpenSidebar);
  }

  const visibleToolCards = hasToolCards && (opts.showToolCalls ?? true);

  // Check if there's any content to render
  if (
    !markdown &&
    !visibleToolCards &&
    !hasImages &&
    assistantAttachments.length === 0 &&
    assistantViewBlocks.length === 0 &&
    !normalizedMessage.replyTarget &&
    !hasMedia
  ) {
    return nothing;
  }

  // Check if after filtering audio/image attachments there's any real content
  const hasNonMediaAttachments = assistantAttachments.some(
    (att) => att.attachment.kind !== "audio" && att.attachment.kind !== "image",
  );
  const hasContentAfterFilter =
    markdown ||
    visibleToolCards ||
    hasImages ||
    hasNonMediaAttachments ||
    assistantViewBlocks.length > 0 ||
    normalizedMessage.replyTarget ||
    hasMedia;

  if (!hasContentAfterFilter) {
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
  const singleToolCard = toolCards.length === 1 ? toolCards[0] : null;
  const toolMessageLabel =
    singleToolCard && !markdown && !hasImages && !hasMedia
      ? singleToolCard.outputText?.trim()
        ? "Tool output"
        : "Tool call"
      : "Tool output";

  const hasActions = canCopyMarkdown || canExpand;

  const styleString = storedSize?.width ? `width: ${storedSize.width}px;` : "";

  const resizeRef = (el: Element | undefined) => {
    if (!isResizable || !el) {
      return;
    }
    if (!(el instanceof HTMLElement)) {
      return;
    }
    if (el.hasAttribute("data-resize-initialized")) {
      return;
    }
    el.setAttribute("data-resize-initialized", "true");
    setTimeout(() => {
      setupResizeHandles(el, "bottom-right", messageId);
    }, 100);
  };

  const detailsId = generateDetailsId(message, 0);
  const isOpen = getDetailsState(detailsId);

  return html`
    <div class="${bubbleClasses}" style="${styleString}" ${ref(resizeRef)}>
      ${renderReplyPill(normalizedMessage.replyTarget)}
      ${hasActions
        ? html`<div class="chat-bubble-actions">
            ${canExpand ? renderExpandButton(markdown!, onOpenSidebar!) : nothing}
            ${canCopyMarkdown ? renderCopyAsMarkdownButton(markdown!) : nothing}
          </div>`
        : nothing}
      ${isToolMessage
        ? html`
            <details
              class="chat-tool-msg-collapse"
              ?open=${isOpen}
              @toggle=${(e: Event) => {
                const details = e.currentTarget as HTMLDetailsElement;
                saveDetailsState(detailsId, details.open);
                if (details.open) {
                  setTimeout(() => {
                    details.scrollIntoView({ behavior: "smooth", block: "nearest" });
                  }, 50);
                }
              }}
            >
              <summary class="chat-tool-msg-summary">
                <span class="chat-tool-msg-summary__icon">${icons.zap}</span>
                <span class="chat-tool-msg-summary__label">${toolMessageLabel}</span>
                ${toolSummaryLabel
                  ? html`<span class="chat-tool-msg-summary__names">${toolSummaryLabel}</span>`
                  : toolPreview
                    ? html`<span class="chat-tool-msg-summary__preview">${toolPreview}</span>`
                    : nothing}
              </summary>
              <div class="chat-tool-msg-body">
                ${renderMessageImages(images)} ${renderMessageMedia(audioBlocks, videoBlocks)}
                ${renderAssistantAttachments(
                  assistantAttachments,
                  opts.localMediaPreviewRoots ?? [],
                  opts.basePath,
                  opts.assistantAttachmentAuthToken,
                  opts.onRequestUpdate,
                )}
                ${reasoningMarkdown
                  ? html`<div class="chat-thinking">
                      ${unsafeHTML(toSanitizedMarkdownHtml(reasoningMarkdown))}
                    </div>`
                  : nothing}
                ${!hasMedia && jsonResult
                  ? html`<details class="chat-json-collapse">
                      <summary class="chat-json-summary">
                        <span class="chat-json-badge">JSON</span>
                        <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
                      </summary>
                      <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
                    </details>`
                  : !hasMedia && markdown
                    ? html`<div class="chat-text" dir="${detectTextDirection(markdown)}">
                        ${markdown.trim().startsWith("<audio")
                          ? unsafeHTML(toSanitizedMarkdownHtml(markdown))
                          : markdown.includes("youtube.com/watch") ||
                              markdown.includes("youtube.com/embed") ||
                              markdown.includes("player.vimeo.com")
                            ? renderVideoEmbed(markdown)
                            : unsafeHTML(toSanitizedMarkdownHtml(markdown))}
                      </div>`
                    : nothing}
                ${hasToolCards
                  ? singleToolCard && !markdown && !hasImages && !hasMedia
                    ? renderExpandedToolCardContent(
                        singleToolCard,
                        onOpenSidebar,
                        opts.canvasHostUrl,
                        opts.embedSandboxMode ?? "scripts",
                        opts.allowExternalEmbedUrls ?? false,
                      )
                    : renderInlineToolCards(toolCards, {
                        messageKey,
                        onOpenSidebar,
                        isToolExpanded: opts.isToolExpanded,
                        onToggleToolExpanded: opts.onToggleToolExpanded,
                        canvasHostUrl: opts.canvasHostUrl,
                        embedSandboxMode: opts.embedSandboxMode ?? "scripts",
                        allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
                      })
                  : nothing}
              </div>
            </details>
          `
        : html`
            ${renderMessageImages(images)} ${renderMessageMedia(audioBlocks, videoBlocks)}
            ${renderAssistantAttachments(
              assistantAttachments,
              opts.localMediaPreviewRoots ?? [],
              opts.basePath,
              opts.assistantAttachmentAuthToken,
              opts.onRequestUpdate,
            )}
            ${reasoningMarkdown
              ? html`<div class="chat-thinking">
                  ${unsafeHTML(toSanitizedMarkdownHtml(reasoningMarkdown))}
                </div>`
              : nothing}
            ${normalizedRole === "assistant" && assistantViewBlocks.length > 0
              ? html`${assistantViewBlocks.map(
                  (block) => html`${renderToolPreview(block.preview, "chat_message", {
                    onOpenSidebar,
                    rawText: block.rawText ?? null,
                    canvasHostUrl: opts.canvasHostUrl,
                    embedSandboxMode: opts.embedSandboxMode ?? "scripts",
                  })}
                  ${block.rawText ? renderRawOutputToggle(block.rawText) : nothing}`,
                )}`
              : nothing}
            ${!hasMedia && jsonResult
              ? html`<details class="chat-json-collapse">
                  <summary class="chat-json-summary">
                    <span class="chat-json-badge">JSON</span>
                    <span class="chat-json-label">${jsonSummaryLabel(jsonResult.parsed)}</span>
                  </summary>
                  <pre class="chat-json-content"><code>${jsonResult.pretty}</code></pre>
                </details>`
              : !hasMedia && markdown
                ? html`<div class="chat-text" dir="${detectTextDirection(markdown)}">
                    ${markdown.trim().startsWith("<audio")
                      ? unsafeHTML(toSanitizedMarkdownHtml(markdown))
                      : markdown.includes("youtube.com/watch") ||
                          markdown.includes("youtube.com/embed") ||
                          markdown.includes("player.vimeo.com")
                        ? renderVideoEmbed(markdown)
                        : unsafeHTML(toSanitizedMarkdownHtml(markdown))}
                  </div>`
                : nothing}
            ${hasToolCards
              ? renderInlineToolCards(toolCards, {
                  messageKey,
                  onOpenSidebar,
                  isToolExpanded: opts.isToolExpanded,
                  onToggleToolExpanded: opts.onToggleToolExpanded,
                  canvasHostUrl: opts.canvasHostUrl,
                  embedSandboxMode: opts.embedSandboxMode ?? "scripts",
                  allowExternalEmbedUrls: opts.allowExternalEmbedUrls ?? false,
                })
              : nothing}
          `}
    </div>
  `;
}
