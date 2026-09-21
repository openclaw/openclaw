import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { t } from "../../../i18n/index.ts";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import {
  isLegacyToolOutputUnavailable,
  toolOutputSourceLabel,
  toolOutputSourceNote,
} from "../../../lib/chat/tool-output.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type {
  SidebarFullMessageLoader,
  ToolOutputSidebarContent,
} from "./chat-sidebar-content-types.ts";

type OutputLoadState = "idle" | "loading" | "loaded" | "unavailable" | "error";

class ChatToolOutput extends OpenClawLightDomElement {
  @property({ attribute: false }) content: ToolOutputSidebarContent | null = null;
  @property({ attribute: false }) loadFullMessage: SidebarFullMessageLoader | null = null;
  @property() connectionEpoch: number | undefined;
  @state() private resolvedCard: ToolCard | null = null;
  @state() private loadState: OutputLoadState = "idle";
  @state() private downloadFailed = false;
  private requestVersion = 0;

  override connectedCallback() {
    super.connectedCallback();
    if (this.hasUpdated && this.loadState === "idle") {
      void this.loadOutput();
    }
  }

  override disconnectedCallback() {
    this.requestVersion += 1;
    if (this.loadState === "loading") {
      this.loadState = "idle";
    }
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("loadFullMessage") && !this.loadFullMessage) {
      this.requestVersion += 1;
      this.loadState = "idle";
    }
    if (changed.has("content") || changed.has("connectionEpoch")) {
      this.requestVersion += 1;
      this.resolvedCard = null;
      this.loadState = "idle";
      this.downloadFailed = false;
    }
    if (
      changed.has("content") ||
      changed.has("connectionEpoch") ||
      (changed.has("loadFullMessage") && !changed.get("loadFullMessage") && this.loadFullMessage)
    ) {
      void this.loadOutput();
    }
  }

  private readonly loadOutput = async () => {
    const content = this.content;
    if (!this.isConnected || !content || this.loadState === "loading") {
      return;
    }
    const { card, sessionKey, agentId } = content;
    if (isLegacyToolOutputUnavailable(card)) {
      this.loadState = "unavailable";
      return;
    }
    if (!sessionKey || !card.resultMessageId || !card.callId || !this.loadFullMessage) {
      if (card.outputTruncated) {
        this.loadState = "unavailable";
      }
      return;
    }
    const version = ++this.requestVersion;
    this.loadState = "loading";
    try {
      const result = await this.loadFullMessage({
        sessionKey,
        agentId,
        messageId: card.resultMessageId,
        maxChars: 2_000_000,
      });
      if (version !== this.requestVersion || this.content !== content || !this.isConnected) {
        return;
      }
      const matches =
        result?.ok && result.message
          ? extractToolCardsCached(result.message).filter(
              (item) => item.callId === card.callId && item.completed,
            )
          : [];
      const output = matches.length === 1 ? matches[0] : undefined;
      if (!output || output.outputText === undefined) {
        this.loadState = "unavailable";
        return;
      }
      this.resolvedCard = { ...card, ...output };
      this.loadState =
        output.outputTruncated || isLegacyToolOutputUnavailable(output) ? "unavailable" : "loaded";
    } catch {
      if (version === this.requestVersion && this.content === content && this.isConnected) {
        this.loadState = "error";
      }
    }
  };

  private downloadOutput(card: ToolCard) {
    this.downloadFailed = false;
    let url: string | undefined;
    try {
      url = URL.createObjectURL(
        new Blob([card.outputText ?? ""], { type: "text/plain;charset=utf-8" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "tool-output.txt";
      anchor.click();
    } catch {
      this.downloadFailed = true;
    } finally {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
  }

  override render() {
    const card = this.resolvedCard ?? this.content?.card;
    if (!card) {
      return nothing;
    }
    const text = card.outputText ?? "";
    const note = toolOutputSourceNote(card);
    return html`<section class="chat-tool-output" aria-busy=${this.loadState === "loading"}>
      <div class="sidebar-header">
        <div class="sidebar-title">${toolOutputSourceLabel(card)}</div>
      </div>
      ${note ? html`<p class="muted">${note}</p>` : nothing}
      ${this.loadState === "loading" ? html`<p role="status">${t("common.loading")}</p>` : nothing}
      ${this.loadState === "unavailable" ? html`<p role="status">${t("chat.toolCards.fullOutputUnavailable")}</p>` : nothing}
      ${this.loadState === "error" ? html`<p role="alert">${t("chat.toolCards.outputLoadFailed")} <button class="btn btn--sm" @click=${this.loadOutput}>${t("common.retry")}</button></p>` : nothing}
      ${
        card.inputText !== undefined
          ? html`<details>
              <summary>${t("chat.toolCards.toolInput")}</summary>
              <pre>${card.inputText}</pre>
            </details>`
          : nothing
      }
      ${
        this.loadState === "loading"
          ? nothing
          : html`<div class="chat-tool-output__actions">
              ${renderCopyButton(text, t("chat.toolCards.copyOutput"))}
              <button class="btn btn--sm" type="button" @click=${() => this.downloadOutput(card)}>
                ${t("chat.toolCards.downloadOutput")}
              </button>
            </div>`
      }
      ${this.downloadFailed ? html`<p role="alert">${t("chat.toolCards.outputDownloadFailed")}</p>` : nothing}
      <pre class="chat-tool-output__text"><code>${text}</code></pre>
    </section>`;
  }
}

if (!customElements.get("openclaw-chat-tool-output")) {
  customElements.define("openclaw-chat-tool-output", ChatToolOutput);
}
