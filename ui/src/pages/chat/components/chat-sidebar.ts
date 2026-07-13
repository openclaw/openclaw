import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { icons } from "../../../components/icons.ts";
import {
  handleMarkdownCodeBlockCopy,
  toSanitizedMarkdownHtml,
} from "../../../components/markdown.ts";
import "../../../components/tooltip.ts";
import { extractRawText } from "../../../lib/chat/message-extract.ts";
import {
  resolveCanvasIframeUrl,
  resolveEmbedSandbox,
  type EmbedSandboxMode,
} from "../../../lib/chat/tool-display.ts";

export const CHAT_DETAIL_FULL_MESSAGE_MAX_CHARS = 500_000;

type DetailUnavailableReason = "not_found" | "oversized" | "not_visible";
export type DetailFullMessageResult = {
  ok?: boolean;
  message?: unknown;
  unavailableReason?: DetailUnavailableReason;
};

export type SidebarFullMessageRequest = {
  sessionKey: string;
  agentId?: string;
  messageId: string;
  kind: "assistant_message" | "tool_output";
};

export type MarkdownSidebarContent = {
  kind: "markdown";
  content: string;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

export type CanvasSidebarContent = {
  kind: "canvas";
  docId: string;
  title?: string;
  entryUrl: string;
  preferredHeight?: number;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

export type ImageSidebarContent = {
  kind: "image";
  title: string;
  src: string;
  mimeType?: string | null;
  rawText?: string | null;
  fullMessageRequest?: SidebarFullMessageRequest;
  unavailableReason?: DetailUnavailableReason | null;
};

export type SidebarContent = MarkdownSidebarContent | CanvasSidebarContent | ImageSidebarContent;

function hasFullMessageRequest(content: SidebarContent): content is SidebarContent & {
  fullMessageRequest: NonNullable<SidebarContent["fullMessageRequest"]>;
} {
  return Boolean(
    content.fullMessageRequest && (content.kind === "markdown" || content.kind === "canvas"),
  );
}

function formatUnavailableReason(reason: DetailUnavailableReason | null | undefined): string {
  switch (reason) {
    case "oversized":
      return "Full content is unavailable because the stored transcript entry is too large to return safely.";
    case "not_visible":
      return "Full content is unavailable because this transcript entry does not have a visible WebChat projection.";
    default:
      return "Full content is no longer available for this transcript entry.";
  }
}

function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  return extractRawText(message);
}

function toPlainTextCodeFence(value: string, language = ""): string {
  const fenceHeader = language ? `\`\`\`${language}` : "```";
  return `${fenceHeader}\n${value}\n\`\`\``;
}

export function buildRawSidebarContent(
  content: SidebarContent | null | undefined,
): SidebarContent | null {
  if (!content) {
    return null;
  }
  if (content.kind === "markdown") {
    const rawText = content.rawText ?? content.content;
    return {
      kind: "markdown",
      content: toPlainTextCodeFence(rawText),
      rawText,
      ...(content.unavailableReason ? { unavailableReason: content.unavailableReason } : {}),
    };
  }
  if (content.rawText?.trim()) {
    return {
      kind: "markdown",
      content: toPlainTextCodeFence(content.rawText, "json"),
      rawText: content.rawText,
      ...(content.unavailableReason ? { unavailableReason: content.unavailableReason } : {}),
    };
  }
  return null;
}

function resolveSidebarCanvasSandbox(
  content: SidebarContent,
  embedSandboxMode: EmbedSandboxMode,
): string {
  return content.kind === "canvas" ? resolveEmbedSandbox(embedSandboxMode) : "allow-scripts";
}

export type MarkdownSidebarProps = {
  content: SidebarContent | null;
  error: string | null;
  onClose: () => void;
  onViewRawText: () => void;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
};

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  const content = props.content;
  const markdownHtml =
    content?.kind === "markdown" && content.content.trim()
      ? toSanitizedMarkdownHtml(content.content)
      : "";
  const canvasSandbox =
    content?.kind === "canvas"
      ? resolveSidebarCanvasSandbox(content, props.embedSandboxMode ?? "scripts")
      : "";
  const canvasSrc =
    content?.kind === "canvas"
      ? resolveCanvasIframeUrl(
          content.entryUrl,
          props.canvasPluginSurfaceUrl,
          props.allowExternalEmbedUrls ?? false,
        )
      : null;
  const title =
    content?.kind === "canvas"
      ? content.title?.trim() || "Render Preview"
      : content?.kind === "image"
        ? content.title.trim() || "Image Preview"
        : content?.kind === "markdown"
          ? "Markdown Preview"
          : "Tool Details";
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">${title}</div>
        <openclaw-tooltip content="Close sidebar">
          <button @click=${props.onClose} class="btn" type="button" aria-label="Close sidebar">
            ${icons.x}
          </button>
        </openclaw-tooltip>
      </div>
      <div class="sidebar-content">
        ${props.error
          ? html`
              <div class="callout danger">${props.error}</div>
              ${content?.rawText?.trim()
                ? html`
                    <button
                      @click=${props.onViewRawText}
                      class="btn"
                      type="button"
                      style="margin-top: 12px;"
                    >
                      View Raw Text
                    </button>
                  `
                : nothing}
            `
          : content
            ? content.kind === "canvas"
              ? html`
                  <div class="chat-tool-card__preview" data-kind="canvas">
                    <div class="chat-tool-card__preview-panel" data-side="front">
                      ${keyed(
                        `${canvasSandbox}\u0000${canvasSrc ?? ""}\u0000${content.preferredHeight ?? ""}`,
                        html`
                          <iframe
                            class="chat-tool-card__preview-frame"
                            title=${content.title?.trim() || "Render preview"}
                            sandbox=${canvasSandbox}
                            src=${canvasSrc ?? nothing}
                            style=${content.preferredHeight
                              ? `height:${content.preferredHeight}px`
                              : ""}
                          ></iframe>
                        `,
                      )}
                    </div>
                    ${content.rawText?.trim()
                      ? html`
                          <div style="margin-top: 12px;">
                            <button @click=${props.onViewRawText} class="btn" type="button">
                              View Raw Text
                            </button>
                          </div>
                        `
                      : nothing}
                  </div>
                `
              : content.kind === "image"
                ? html`
                    <div class="chat-tool-card__preview" data-kind="image">
                      <div class="chat-tool-card__preview-panel" data-side="front">
                        <img
                          class="chat-tool-card__preview-image"
                          src=${content.src}
                          alt=${title}
                          style="display:block;max-width:100%;height:auto;border-radius:8px;"
                        />
                      </div>
                      ${content.rawText?.trim()
                        ? html`
                            <div style="margin-top: 12px;">
                              <button @click=${props.onViewRawText} class="btn" type="button">
                                View Raw Text
                              </button>
                            </div>
                          `
                        : nothing}
                    </div>
                  `
                : html`
                    <section class="sidebar-markdown-shell">
                      <div class="sidebar-markdown-shell__toolbar">
                        <div class="sidebar-markdown-shell__intro">
                          <div class="sidebar-markdown-shell__eyebrow">
                            ${icons.scrollText}
                            <span>Rendered Markdown</span>
                          </div>
                          <div class="sidebar-markdown-shell__hint">
                            Sanitized rich-text preview for quick reading.
                          </div>
                        </div>
                        <button @click=${props.onViewRawText} class="btn btn--sm" type="button">
                          View Raw Text
                        </button>
                      </div>
                      ${markdownHtml
                        ? html`
                            <article class="sidebar-markdown-reader sidebar-markdown">
                              ${unsafeHTML(markdownHtml)}
                            </article>
                          `
                        : html`
                            <div class="sidebar-markdown-empty">
                              No previewable markdown content.
                            </div>
                          `}
                    </section>
                  `
            : html` <div class="muted">No content available</div> `}
      </div>
    </div>
  `;
}

export class ChatDetailPanel extends LitElement {
  @property({ attribute: false }) content: SidebarContent | null = null;
  @property({ attribute: false }) loadFullMessage?:
    | ((request: SidebarFullMessageRequest) => Promise<DetailFullMessageResult | null | undefined>)
    | null = null;
  @property() canvasPluginSurfaceUrl: string | null = null;
  @property() embedSandboxMode: EmbedSandboxMode = "scripts";
  @property({ type: Boolean }) allowExternalEmbedUrls = false;

  @state() private visibleContent: SidebarContent | null = null;
  @state() private error: string | null = null;

  private requestVersion = 0;
  private showingRawText = false;

  override createRenderRoot() {
    return this;
  }

  protected override willUpdate(changed: Map<string, unknown>) {
    if (!changed.has("content")) {
      return;
    }
    this.requestVersion += 1;
    this.visibleContent = this.content;
    this.error = null;
    this.showingRawText = false;
  }

  protected override updated(changed: Map<string, unknown>) {
    if (!changed.has("content") && !changed.has("loadFullMessage")) {
      return;
    }
    const content = this.content;
    if (!content || this.showingRawText) {
      return;
    }
    const version = ++this.requestVersion;
    void this.upgradeToFullMessage(content, version);
  }

  private async upgradeToFullMessage(content: SidebarContent, version: number) {
    if (!hasFullMessageRequest(content) || !this.loadFullMessage) {
      return;
    }
    const request = content.fullMessageRequest;
    try {
      const result = await this.loadFullMessage(request);
      if (version !== this.requestVersion || this.content !== content) {
        return;
      }
      if (!result?.ok || !result.message || typeof result.message !== "object") {
        this.visibleContent = {
          ...content,
          unavailableReason: result?.unavailableReason ?? "not_found",
        };
        this.error = formatUnavailableReason(result?.unavailableReason ?? "not_found");
        return;
      }
      const fetchedText = extractMessageText(result.message);
      const rawText =
        fetchedText ??
        (typeof content.rawText === "string"
          ? content.rawText
          : content.kind === "markdown"
            ? content.content
            : null);
      this.visibleContent =
        content.kind === "markdown"
          ? {
              ...content,
              content: rawText || content.content,
              rawText: rawText || content.rawText || content.content,
              unavailableReason: null,
            }
          : {
              ...content,
              rawText: rawText || content.rawText || null,
              unavailableReason: null,
            };
      this.error = null;
    } catch (error) {
      if (version !== this.requestVersion || this.content !== content) {
        return;
      }
      this.error = `Failed to load full content: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  private readonly close = () => {
    this.dispatchEvent(new CustomEvent("chat-detail-panel-close", { bubbles: true }));
  };

  private readonly showRawText = () => {
    const rawContent = buildRawSidebarContent(this.visibleContent);
    if (!rawContent) {
      return;
    }
    this.requestVersion += 1;
    this.showingRawText = true;
    this.visibleContent = rawContent;
    this.error = null;
  };

  override render() {
    return html`
      <div @click=${handleMarkdownCodeBlockCopy}>
        ${renderMarkdownSidebar({
          content: this.visibleContent,
          error: this.error,
          canvasPluginSurfaceUrl: this.canvasPluginSurfaceUrl,
          embedSandboxMode: this.embedSandboxMode,
          allowExternalEmbedUrls: this.allowExternalEmbedUrls,
          onClose: this.close,
          onViewRawText: this.showRawText,
        })}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-detail-panel")) {
  customElements.define("openclaw-chat-detail-panel", ChatDetailPanel);
}
