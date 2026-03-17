import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { classMap } from "lit/directives/class-map.js";
import {
  clearDebugLogs,
  exportDebugLogsAsText,
  getDebugLogs,
  isDebugEnabled,
  setDebugEnabled,
  debugLog,
  type DebugLogEntry,
} from "./debug-connection.ts";

/**
 * Interface for gateway client that the app exposes
 */
interface GatewayClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  connected: boolean;
}

@customElement("debug-drawer")
export class DebugDrawer extends LitElement {
  @property({ type: Boolean }) open = false;
  @property({ type: Object }) gatewayClient?: GatewayClient;

  @state() private logs: DebugLogEntry[] = [];
  @state() private autoScroll = true;
  @state() private gatewayLogs: string[] = [];
  @state() private loadingGatewayLogs = false;

  connectedCallback() {
    super.connectedCallback();
    this.refreshLogs();
    // Poll for new logs
    this._pollInterval = window.setInterval(() => this.refreshLogs(), 500);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollInterval) {
      window.clearInterval(this._pollInterval);
    }
    if (this._gatewayLogsInterval) {
      window.clearInterval(this._gatewayLogsInterval);
    }
  }

  private _pollInterval: number | null = null;
  private _gatewayLogsInterval: number | null = null;

  private refreshLogs() {
    this.logs = getDebugLogs();
  }

  private handleToggle() {
    const newValue = !isDebugEnabled();
    setDebugEnabled(newValue);
    this.requestUpdate();

    // Start/stop gateway logs polling
    if (newValue && this.gatewayClient?.connected) {
      this.loadGatewayLogs();
      this._gatewayLogsInterval = window.setInterval(() => this.loadGatewayLogs(), 2000);
    } else {
      if (this._gatewayLogsInterval) {
        window.clearInterval(this._gatewayLogsInterval);
        this._gatewayLogsInterval = null;
      }
    }
  }

  private async loadGatewayLogs() {
    if (!this.gatewayClient?.connected || this.loadingGatewayLogs) {
      return;
    }
    this.loadingGatewayLogs = true;
    try {
      const result = (await this.gatewayClient.request<{ entries: string[] }>("logs.tail", {
        limit: 50,
        filter: "error warn",
      })) as { entries?: string[] };
      const entries = result?.entries ?? [];
      if (entries.length > 0 && isDebugEnabled()) {
        // Add to debug logs
        entries.forEach((entry) => {
          const level = entry.toLowerCase().includes("error")
            ? "error"
            : entry.toLowerCase().includes("warn")
              ? "warn"
              : "info";
          debugLog.info("logs", entry);
        });
      }
      this.gatewayLogs = entries.slice(-50);
    } catch (err) {
      // Silently ignore errors - gateway logs are optional
    } finally {
      this.loadingGatewayLogs = false;
    }
  }

  private handleClear() {
    clearDebugLogs();
    this.gatewayLogs = [];
    this.refreshLogs();
  }

  private async handleCopy() {
    const debugText = exportDebugLogsAsText();
    const gatewayText = this.gatewayLogs.join("\n");
    const text = `=== Connection Debug Logs ===\n\n${debugText}\n\n=== Gateway Logs (last 50) ===\n\n${gatewayText}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  }

  private handleClose() {
    this.dispatchEvent(new CustomEvent("close"));
  }

  private handleScroll(e: Event) {
    const target = e.target as HTMLElement;
    const isAtBottom = target.scrollHeight - target.scrollTop <= target.clientHeight + 50;
    this.autoScroll = isAtBottom;
  }

  render() {
    const enabled = isDebugEnabled();

    return html`
      <div class=${classMap({ "debug-drawer-overlay": true, open: this.open })} @click=${this.handleClose}>
        <div class=${classMap({ "debug-drawer": true, open: this.open })} @click=${(e: Event) => e.stopPropagation()}>
          <div class="debug-drawer__header">
            <div class="debug-drawer__title">
              <span class="debug-drawer__icon">🔧</span>
              Connection Debug
            </div>
            <div class="debug-drawer__controls">
              <label class="debug-drawer__toggle">
                <input type="checkbox" .checked=${enabled} @change=${this.handleToggle} />
                <span>Debug Mode</span>
              </label>
              <button class="debug-drawer__btn" @click=${this.handleCopy} title="Copy to clipboard">
                📋
              </button>
              <button class="debug-drawer__btn" @click=${this.handleClear} title="Clear logs">
                🗑️
              </button>
              <button class="debug-drawer__btn" @click=${this.handleClose} title="Close">
                ✕
              </button>
            </div>
          </div>

          ${!enabled
            ? html`
                <div class="debug-drawer__empty">
                  Enable debug mode to capture connection logs.<br /><br />
                  <small>Keyboard: Ctrl+Shift+D</small>
                </div>
              `
            : this.logs.length === 0 && this.gatewayLogs.length === 0
              ? html`
                  <div class="debug-drawer__empty">
                    No logs yet. Connection events will appear here.
                  </div>
                `
              : html`
                <div class="debug-drawer__content" @scroll=${this.handleScroll}>
                  ${this.gatewayLogs.length > 0
                    ? html`
                        <div class="debug-drawer__section">
                          <div class="debug-drawer__section-title">Gateway Logs</div>
                          ${this.gatewayLogs.map(
                            (log) => html`
                              <div class="debug-drawer__gateway-entry">${log}</div>
                            `,
                          )}
                        </div>
                      `
                    : nothing}
                  ${this.logs.map(
                    (log) => html`
                      <div class="debug-drawer__entry ${log.level}">
                        <div class="debug-drawer__entry-header">
                          <span class="debug-drawer__entry-time">${new Date(log.ts).toLocaleTimeString()}</span>
                          <span class="debug-drawer__entry-level ${log.level}">${log.level}</span>
                          <span class="debug-drawer__entry-source">${log.source}</span>
                        </div>
                        <div class="debug-drawer__entry-message">${log.message}</div>
                        ${log.details
                          ? html`
                              <pre class="debug-drawer__entry-details">${JSON.stringify(log.details, null, 2)}</pre>
                            `
                          : nothing}
                      </div>
                    `,
                  )}
                </div>
                <div class="debug-drawer__footer">
                  <span class="debug-drawer__count">${this.logs.length} entries</span>
                  <span class="debug-drawer__hint">Logs are ephemeral - cleared on tab close</span>
                </div>
              `}
        </div>
      </div>
    `;
  }

  static styles = `
    .debug-drawer-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 9999;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.2s, visibility 0.2s;
    }

    .debug-drawer-overlay.open {
      opacity: 1;
      visibility: visible;
    }

    .debug-drawer {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 500px;
      max-width: 90vw;
      background: #1a1a2e;
      border-left: 1px solid #333;
      display: flex;
      flex-direction: column;
      transform: translateX(100%);
      transition: transform 0.3s ease;
    }

    .debug-drawer.open {
      transform: translateX(0);
    }

    .debug-drawer__header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: #16213e;
      border-bottom: 1px solid #333;
    }

    .debug-drawer__title {
      font-size: 14px;
      font-weight: 600;
      color: #eee;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .debug-drawer__icon {
      font-size: 16px;
    }

    .debug-drawer__controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .debug-drawer__toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #aaa;
      cursor: pointer;
    }

    .debug-drawer__toggle input {
      cursor: pointer;
    }

    .debug-drawer__btn {
      background: transparent;
      border: none;
      font-size: 14px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      color: #aaa;
      transition: background 0.2s;
    }

    .debug-drawer__btn:hover {
      background: #333;
      color: #fff;
    }

    .debug-drawer__empty {
      padding: 40px 20px;
      text-align: center;
      color: #666;
      font-size: 13px;
    }

    .debug-drawer__content {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      font-family: "SF Mono", "Monaco", "Consolas", monospace;
      font-size: 11px;
    }

    .debug-drawer__section {
      margin-bottom: 12px;
      padding-bottom: 12px;
      border-bottom: 1px solid #333;
    }

    .debug-drawer__section-title {
      font-size: 11px;
      color: #888;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .debug-drawer__gateway-entry {
      padding: 4px 8px;
      margin-bottom: 2px;
      background: #0f0f1a;
      border-radius: 2px;
      color: #aaa;
      font-size: 10px;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .debug-drawer__entry {
      padding: 8px;
      margin-bottom: 4px;
      background: #0f0f1a;
      border-radius: 4px;
      border-left: 3px solid #444;
    }

    .debug-drawer__entry.info {
      border-left-color: #4a9eff;
    }

    .debug-drawer__entry.warn {
      border-left-color: #ffa500;
    }

    .debug-drawer__entry.error {
      border-left-color: #ff4a4a;
    }

    .debug-drawer__entry.debug {
      border-left-color: #888;
    }

    .debug-drawer__entry-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }

    .debug-drawer__entry-time {
      color: #666;
    }

    .debug-drawer__entry-level {
      padding: 1px 4px;
      border-radius: 2px;
      font-size: 10px;
      text-transform: uppercase;
    }

    .debug-drawer__entry-level.info {
      background: #4a9eff22;
      color: #4a9eff;
    }

    .debug-drawer__entry-level.warn {
      background: #ffa50022;
      color: #ffa500;
    }

    .debug-drawer__entry-level.error {
      background: #ff4a4a22;
      color: #ff4a4a;
    }

    .debug-drawer__entry-level.debug {
      background: #88888822;
      color: #888;
    }

    .debug-drawer__entry-source {
      color: #666;
      font-size: 10px;
    }

    .debug-drawer__entry-message {
      color: #ccc;
      word-break: break-word;
    }

    .debug-drawer__entry-details {
      margin-top: 4px;
      padding: 4px;
      background: #00000044;
      border-radius: 2px;
      color: #888;
      font-size: 10px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .debug-drawer__footer {
      padding: 8px 16px;
      background: #16213e;
      border-top: 1px solid #333;
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #666;
    }

    .debug-drawer__count {
      color: #888;
    }

    .debug-drawer__hint {
      font-style: italic;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "debug-drawer": DebugDrawer;
  }
}
