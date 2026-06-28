import { LitElement, html } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { handleMarkdownCodeBlockCopy } from "../../components/markdown.ts";
import type { EmbedSandboxMode } from "../../ui/embed-sandbox.ts";
import type { SidebarContent } from "../../ui/sidebar-content.ts";
import { renderMarkdownSidebar } from "../../ui/views/markdown-sidebar.ts";
import { buildRawSidebarContent } from "./chat-sidebar-raw.ts";
import { extractRawText } from "./message-extract.ts";

const FULL_MESSAGE_DETAIL_MAX_CHARS = 500_000;

type DetailUnavailableReason = "not_found" | "oversized" | "not_visible";
type DetailFullMessageResult = {
  ok?: boolean;
  message?: unknown;
  unavailableReason?: DetailUnavailableReason;
};

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

export class ChatDetailPanel extends LitElement {
  @property({ attribute: false }) content: SidebarContent | null = null;
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
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
    if (!changed.has("content") && !changed.has("client")) {
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
    if (!hasFullMessageRequest(content) || !this.client) {
      return;
    }
    const request = content.fullMessageRequest;
    try {
      const result = await this.client.request<DetailFullMessageResult>("chat.message.get", {
        sessionKey: request.sessionKey,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        messageId: request.messageId,
        maxChars: FULL_MESSAGE_DETAIL_MAX_CHARS,
      });
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
