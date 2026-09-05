import { css, html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";

export type PanelLoadingSkeletonVariant =
  | "browser"
  | "chat"
  | "desktop"
  | "discussion"
  | "files"
  | "review"
  | "tasks"
  | "terminal";

class PanelLoadingSkeleton extends OpenClawLitElement {
  @property({ reflect: true, attribute: "data-panel-skeleton" })
  variant: PanelLoadingSkeletonVariant = "files";

  @property({ type: Boolean, reflect: true }) compact = false;

  @property({ type: Boolean, reflect: true }) overlay = false;

  static override styles = css`
    :host {
      display: block;
      box-sizing: border-box;
      width: 100%;
      min-height: 100%;
      padding: 14px;
      color: var(--muted);
    }

    :host([compact]) {
      min-height: 0;
      padding: 8px;
    }

    :host([data-panel-skeleton="chat"]:not([compact])) {
      display: flex;
      align-items: flex-start;
      min-height: clamp(360px, calc(100vh - 300px), 620px);
      padding-block: 20px;
    }

    :host([overlay]) {
      position: absolute;
      inset: 0;
      z-index: 2;
      min-height: 0;
      background: color-mix(in srgb, var(--bg, #0e1015) 92%, transparent);
      pointer-events: none;
    }

    :host([compact]) .viewport,
    :host([compact]) .terminal,
    :host([compact]) .discussion-frame {
      min-height: 72px;
    }

    * {
      box-sizing: border-box;
    }

    /* Terminal/desktop/browser hosts use shadow roots, so base.css's .skeleton
       and global reduced-motion gate cannot reach here. Keep this primitive
       declaration-identical to base.css; the unit test guards against drift. */
    .skeleton {
      position: relative;
      overflow: hidden;
      background: var(--skeleton-base, var(--bg-muted));
      border-radius: var(--radius-md);
    }

    .skeleton::after {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        transparent 25%,
        var(--skeleton-highlight, var(--bg-hover)) 50%,
        transparent 75%
      );
      content: "";
      transform: translateX(-100%);
      animation: shimmer var(--skeleton-duration, 1.5s) ease-in-out infinite;
      will-change: transform;
    }

    .line {
      height: 10px;
    }

    .short {
      width: 36%;
    }

    .medium {
      width: 62%;
    }

    .long {
      width: 88%;
    }

    .row,
    .toolbar,
    .card,
    .summary {
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .rows,
    .conversation,
    .code {
      display: grid;
      gap: 12px;
    }

    .toolbar {
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 14px;
    }

    .icon {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
      border-radius: 5px;
    }

    .copy {
      display: grid;
      flex: 1;
      gap: 6px;
    }

    .meta {
      height: 7px;
      width: 28%;
    }

    .viewport {
      min-height: 220px;
      border-radius: 8px;
    }

    .address {
      height: 28px;
      flex: 1;
      border-radius: 7px;
    }

    .button {
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
    }

    .card {
      min-height: 58px;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    .summary {
      margin-bottom: 16px;
    }

    .pill {
      width: 64px;
      height: 24px;
      border-radius: 999px;
    }

    .file-heading {
      height: 30px;
      margin-bottom: 14px;
    }

    .code .line {
      height: 9px;
      border-radius: 3px;
    }

    .terminal {
      display: grid;
      gap: 11px;
      padding: 12px;
      min-height: 220px;
      align-content: start;
      border-radius: 8px;
      background: color-mix(in srgb, var(--bg) 76%, transparent);
    }

    .chat-turn {
      display: flex;
      width: 100%;
      align-items: flex-start;
    }

    .chat-turn.assistant {
      padding: 3px 0;
    }

    .chat-turn.user {
      width: 68%;
      min-height: 52px;
      margin-left: auto;
      padding: 12px;
      border-radius: 12px;
      background: color-mix(in srgb, var(--bg-muted) 76%, transparent);
    }

    @media (max-width: 768px),
      (max-width: 932px) and (max-height: 500px) and (orientation: landscape) {
      .chat-turn.user {
        width: 82%;
      }
    }

    @media (max-width: 400px) {
      .chat-turn.user {
        width: 88%;
      }
    }

    :host([data-panel-skeleton="chat"]:not([compact])) .conversation {
      width: 100%;
      gap: 50px;
    }

    :host([compact]) .chat-turn {
      width: 88%;
    }

    :host([compact]) .chat-turn.user {
      width: 64%;
      min-height: 42px;
      padding: 9px;
    }

    .discussion-frame {
      min-height: 280px;
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    @keyframes shimmer {
      from {
        transform: translateX(-100%);
      }
      to {
        transform: translateX(100%);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .skeleton::after {
        animation-duration: 0.01ms;
        animation-iteration-count: 1;
      }
    }
  `;

  private line(width: "short" | "medium" | "long" = "long") {
    return html`<div class="skeleton line ${width}"></div>`;
  }

  private rows(count: number) {
    return Array.from(
      { length: count },
      (_, index) => html`
        <div class="row">
          <div class="skeleton icon"></div>
          <div class="copy">
            ${this.line(index % 2 === 0 ? "long" : "medium")}
            <div class="skeleton meta"></div>
          </div>
        </div>
      `,
    );
  }

  private chatTurn(role: "assistant" | "user", widths: Array<"short" | "medium" | "long">) {
    return html`
      <div class="chat-turn ${role}" data-skeleton-role=${role}>
        <div class="copy">${widths.map((width) => this.line(width))}</div>
      </div>
    `;
  }

  private renderChatConversation() {
    if (this.compact) {
      return html`
        <div class="conversation">
          ${this.chatTurn("assistant", ["long", "medium"])} ${this.chatTurn("user", ["medium"])}
          ${this.chatTurn("assistant", ["long", "short"])}
        </div>
      `;
    }
    return html`
      <div class="conversation">
        ${this.chatTurn("user", ["medium"])}
        ${this.chatTurn("assistant", ["long", "long", "medium", "short"])}
        ${this.chatTurn("user", ["long", "short"])}
        ${this.chatTurn("assistant", ["long", "medium", "long"])}
        ${this.chatTurn("user", ["medium"])}
      </div>
    `;
  }

  private renderContent() {
    switch (this.variant) {
      case "browser":
        return html`
          <div class="toolbar">
            <div class="skeleton button"></div>
            <div class="skeleton button"></div>
            <div class="skeleton address"></div>
          </div>
          <div class="skeleton viewport"></div>
        `;
      case "chat":
        return this.renderChatConversation();
      case "desktop":
        return html`
          <div class="toolbar">${this.line("medium")}</div>
          <div class="rows">${this.rows(3).map((row) => html`<div class="card">${row}</div>`)}</div>
        `;
      case "discussion":
        return html`
          <div class="discussion-frame">
            <div class="conversation">
              ${this.line("medium")} ${this.line()} ${this.line("long")} ${this.line("short")}
            </div>
          </div>
        `;
      case "review":
        return html`
          <div class="summary">
            <div class="skeleton pill"></div>
            <div class="skeleton pill"></div>
          </div>
          <div class="skeleton file-heading"></div>
          <div class="code">
            ${this.line()} ${this.line("long")} ${this.line("medium")} ${this.line()}
            ${this.line("short")}
          </div>
        `;
      case "terminal":
        return html`
          <div class="toolbar">
            <div class="skeleton pill"></div>
            <div class="skeleton pill"></div>
          </div>
          <div class="terminal">
            ${this.line("medium")} ${this.line()} ${this.line("short")} ${this.line("long")}
          </div>
        `;
      case "tasks":
        return html`
          <div class="toolbar">${this.line("short")}</div>
          <div class="rows">${this.rows(4)}</div>
        `;
      default:
        return html`
          <div class="toolbar">
            <div class="skeleton address"></div>
            <div class="skeleton button"></div>
          </div>
          <div class="rows">${this.rows(5)}</div>
        `;
    }
  }

  override render() {
    return html`${this.renderContent()}`;
  }
}

export function renderPanelLoadingSkeleton(
  variant: PanelLoadingSkeletonVariant,
  label: string,
  compact = false,
  overlay = false,
): TemplateResult {
  return html`
    <openclaw-panel-loading-skeleton
      .variant=${variant}
      ?compact=${compact}
      ?overlay=${overlay}
      role="status"
      aria-busy="true"
      aria-label=${label}
    ></openclaw-panel-loading-skeleton>
  `;
}

if (!customElements.get("openclaw-panel-loading-skeleton")) {
  customElements.define("openclaw-panel-loading-skeleton", PanelLoadingSkeleton);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-panel-loading-skeleton": PanelLoadingSkeleton;
  }
}
