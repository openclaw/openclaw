/**
 * Status Bar Island — Bottom bar showing real-time system telemetry.
 *
 * Displays connection status, server version, uptime, storage/cache backends,
 * active model, presence count, and auth role. Responsive: hides less
 * important items on smaller viewports via CSS classes.
 */

import { StoreController } from "@nanostores/lit";
import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { gateway } from "../../services/gateway.ts";
import { $connected } from "../../stores/app.ts";
import { $hello } from "../../stores/gateway.ts";

type SystemInfo = {
  version: string;
  host: string;
  platform: string;
  arch: string;
  storage: { backend: string; details?: string };
  cache: { backend: string; host?: string; port?: number };
  model: string;
  nodeVersion: string;
};

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

@customElement("statusbar-island")
export class StatusbarIsland extends LitElement {
  private connectedCtrl = new StoreController(this, $connected);
  private helloCtrl = new StoreController(this, $hello);

  @state() private sysInfo: SystemInfo | null = null;
  @state() private uptimeDisplay = "—";

  private uptimeTimer: ReturnType<typeof setInterval> | null = null;
  private connectedAtMs: number | null = null;
  private initialUptimeMs: number | null = null;
  private lastFetchedForConnId: string | null = null;

  // Light DOM — inherit page CSS
  protected createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.uptimeTimer = setInterval(() => this.updateUptime(), 60_000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.uptimeTimer) {
      clearInterval(this.uptimeTimer);
      this.uptimeTimer = null;
    }
  }

  updated() {
    const hello = this.helloCtrl.value;
    const isConnected = this.connectedCtrl.value;

    if (isConnected && hello) {
      // Extract connId to avoid re-fetching on every render
      const snapshot = hello.snapshot as
        | { uptimeMs?: number; presence?: unknown[]; authMode?: string }
        | undefined;
      const server = (hello as { server?: { version?: string; connId?: string } }).server;
      const connId = server?.connId ?? null;

      // Track uptime from handshake snapshot
      if (snapshot?.uptimeMs != null && this.initialUptimeMs === null) {
        this.initialUptimeMs = snapshot.uptimeMs;
        this.connectedAtMs = Date.now();
        this.updateUptime();
      }

      // Fetch system.info once per connection
      if (connId && connId !== this.lastFetchedForConnId) {
        this.lastFetchedForConnId = connId;
        this.fetchSystemInfo();
      }
    }

    if (!isConnected) {
      this.uptimeDisplay = "—";
      this.initialUptimeMs = null;
      this.connectedAtMs = null;
      this.lastFetchedForConnId = null;
    }
  }

  private updateUptime() {
    if (this.initialUptimeMs == null || this.connectedAtMs == null) {
      return;
    }
    const elapsed = Date.now() - this.connectedAtMs;
    this.uptimeDisplay = formatUptime(this.initialUptimeMs + elapsed);
  }

  private async fetchSystemInfo() {
    try {
      const info = await gateway.call<SystemInfo>("system.info");
      this.sysInfo = info;
    } catch {
      // Non-critical — leave sysInfo null
    }
  }

  render() {
    const isConnected = this.connectedCtrl.value;
    const hello = this.helloCtrl.value;
    const snapshot = hello?.snapshot as { presence?: unknown[]; authMode?: string } | undefined;
    const auth = hello?.auth as { role?: string } | undefined;
    const server = (hello as { server?: { version?: string } } | null)?.server;

    const presenceCount = Array.isArray(snapshot?.presence) ? snapshot.presence.length : 0;
    const role = auth?.role ?? null;
    const version = server?.version ?? this.sysInfo?.version ?? null;

    const sep = html`
      <span class="statusbar-sep">|</span>
    `;

    return html`
      <footer class="statusbar">
        <div class="statusbar-left">
          ${
            isConnected
              ? html`
                  <span class="statusbar-item statusbar-conn">
                    <span class="statusbar-dot statusbar-dot--ok"></span>
                    <span class="statusbar-detail statusbar-detail--med">Connected</span>
                  </span>
                `
              : html`
                  <span class="statusbar-item statusbar-conn">
                    <span class="statusbar-dot statusbar-dot--err"></span>
                    <span class="statusbar-detail statusbar-detail--med">Disconnected</span>
                  </span>
                `
          }

          ${
            version
              ? html`${sep}<span class="statusbar-item statusbar-detail">v${version}</span>`
              : nothing
          }

          ${
            isConnected && this.uptimeDisplay !== "—"
              ? html`
                <span class="statusbar-sep statusbar-detail statusbar-detail--med">|</span>
                <span class="statusbar-item statusbar-detail statusbar-detail--med"
                  >${this.uptimeDisplay}</span
                >
              `
              : nothing
          }

          ${
            this.sysInfo?.storage.backend
              ? html`
                <span class="statusbar-sep statusbar-detail statusbar-detail--low">|</span>
                <span class="statusbar-item statusbar-detail statusbar-detail--low">
                  <span class="statusbar-badge">${this.sysInfo.storage.backend}</span>
                </span>
              `
              : nothing
          }

          ${
            this.sysInfo?.cache.backend
              ? html`
                <span class="statusbar-sep statusbar-detail statusbar-detail--low">|</span>
                <span class="statusbar-item statusbar-detail statusbar-detail--low">
                  <span class="statusbar-badge">${this.sysInfo.cache.backend}</span>
                </span>
              `
              : nothing
          }

          ${
            this.sysInfo?.model
              ? html`
                <span class="statusbar-sep statusbar-detail statusbar-detail--med">|</span>
                <span class="statusbar-item statusbar-detail statusbar-detail--med"
                  >${this.sysInfo.model}</span
                >
              `
              : nothing
          }
        </div>

        <div class="statusbar-right">
          ${
            presenceCount > 0
              ? html`
                <span class="statusbar-item statusbar-detail">
                  ${presenceCount} active
                </span>
              `
              : nothing
          }

          ${
            role
              ? html`
                ${
                  presenceCount > 0
                    ? html`
                        <span class="statusbar-sep statusbar-detail">|</span>
                      `
                    : nothing
                }
                <span class="statusbar-item statusbar-detail">
                  <span class="statusbar-badge">${role}</span>
                </span>
              `
              : nothing
          }
        </div>
      </footer>
    `;
  }
}
