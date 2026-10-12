import { css, html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";
import { mcpAppBannerStyles } from "./mcp-app-view-styles.ts";

registerMcpAppEnglish();

const styles = css`
  .mcp-app-confirm {
    ${mcpAppBannerStyles}
    position: relative;
    z-index: 1;
    box-sizing: border-box;
    flex-shrink: 0;
    flex-wrap: wrap;
    font: 13px/1.4 var(--font-body, sans-serif);
    border-bottom: 1px solid var(--border);
  }
  .mcp-app-confirm:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .mcp-app-confirm__copy {
    flex: 1 1 240px;
    min-width: 0;
  }
  .mcp-app-confirm__title,
  .mcp-app-confirm__preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mcp-app-confirm__title {
    font-weight: 600;
  }
  .mcp-app-confirm__preview {
    color: var(--muted);
    margin-top: 4px;
  }
  .mcp-app-confirm__actions {
    display: flex;
    flex-shrink: 0;
    gap: 8px;
  }
  .mcp-app-confirm__actions button {
    padding: 7px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  .mcp-app-confirm__actions .mcp-app-confirm__accept {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-foreground);
  }
`;

type Confirmation = {
  frame: HTMLIFrameElement;
  title: string;
  text: string;
  kind: "message" | "file";
  isCurrent: () => boolean;
};

/** One pending decision shared by all App requests in the owning pane. */
export class McpAppConfirm {
  private pending: (Confirmation & { resolve: (accepted: boolean) => void }) | null = null;

  constructor(private readonly requestUpdate: () => void) {}

  request(confirmation: Confirmation): Promise<boolean> {
    if (this.pending || !confirmation.isCurrent()) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      this.pending = { ...confirmation, resolve };
      this.requestUpdate();
    });
  }

  cancel(): void {
    this.finish(false, false);
  }

  update(): void {
    if (this.pending && !this.pending.isCurrent()) {
      this.cancel();
    }
  }

  readonly focusStrip = (element: Element | undefined): void => {
    const pending = this.pending;
    // Lit assigns the ref before inserting the strip into the document.
    queueMicrotask(() => {
      if (element instanceof HTMLElement && element.isConnected && this.pending === pending) {
        element.focus({ preventScroll: true });
      }
    });
  };

  finish(accepted: boolean, restoreFocus = true): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = null;
    this.requestUpdate();
    const current = pending.isCurrent() && pending.frame.isConnected;
    if (restoreFocus && current) {
      pending.frame.focus({ preventScroll: true });
    }
    pending.resolve(accepted && current);
  }

  get current() {
    return this.pending;
  }

  render() {
    const pending = this.pending;
    if (!pending) {
      return nothing;
    }
    const question = t(pending.kind === "message" ? "mcpApp.confirmMessage" : "mcpApp.confirmFile");
    return html`
      <style>
        ${styles}
      </style>
      <div
        class="mcp-app-confirm"
        role="alertdialog"
        aria-label=${`${pending.title}: ${question}`}
        tabindex="-1"
        ${ref(this.focusStrip)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape" || event.key === "Enter") {
            event.stopPropagation();
            if (event.key === "Escape" || event.target === event.currentTarget) {
              event.preventDefault();
              this.finish(event.key === "Enter");
            }
          }
        }}
      >
        <div class="mcp-app-confirm__copy">
          <div class="mcp-app-confirm__title" title=${pending.title}>${pending.title}</div>
          <div>${question}</div>
          <div class="mcp-app-confirm__preview" title=${pending.text}>
            ${pending.text.length > 200 ? `${pending.text.slice(0, 200)}…` : pending.text}
          </div>
        </div>
        <div class="mcp-app-confirm__actions">
          <button class="mcp-app-confirm__accept" type="button" @click=${() => this.finish(true)}>
            ${t(pending.kind === "message" ? "mcpApp.sendMessage" : "mcpApp.openFile")}
          </button>
          <button type="button" @click=${() => this.finish(false)}>${t("mcpApp.cancel")}</button>
        </div>
      </div>
    `;
  }
}
