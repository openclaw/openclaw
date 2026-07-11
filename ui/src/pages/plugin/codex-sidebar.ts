import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { OpenClawLightDomContentsElement } from "../../lit/openclaw-element.ts";
import {
  getCodexSessionsState,
  loadCodexSessions,
  loadMoreCodexSessions,
  stopCodexSessionsPolling,
  type CodexSessionPayload,
} from "./codex-sessions-controller.ts";
import { pluginTabSearch } from "./route.ts";

const SIDEBAR_REFRESH_INTERVAL_MS = 30_000;
const MAX_CATALOG_PAGES_PER_HOST = 100;
const MAX_CATALOG_SESSIONS_PER_HOST = 4_000;

function sessionTitle(session: CodexSessionPayload): string {
  return session.name?.trim() || t("codexSessions.untitled");
}

function sessionTimestamp(session: CodexSessionPayload): string {
  const value = session.recencyAt ?? session.updatedAt;
  if (!value || !Number.isFinite(value)) {
    return "";
  }
  return formatRelativeTimestamp(value < 1_000_000_000_000 ? value * 1_000 : value);
}

export class CodexSidebar extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) selectedHostId = "";
  @property({ attribute: false }) selectedThreadId = "";
  @property({ attribute: false }) onOpenSession?: (hostId: string, threadId: string) => void;
  @property({ attribute: false }) onViewAll?: () => void;
  @state() private revision = 0;
  @state() private truncatedHostIds = new Set<string>();

  private readonly controllerHost = {};
  private loadedClient: GatewayBrowserClient | null = null;
  private hydrationToken: object | null = null;
  private refreshTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  override disconnectedCallback() {
    this.hydrationToken = null;
    this.clearRefreshTimer();
    stopCodexSessionsPolling(this.controllerHost);
    super.disconnectedCallback();
  }

  override willUpdate() {
    const sessionsState = getCodexSessionsState(this.controllerHost);
    sessionsState.requestUpdate = () => {
      this.revision += 1;
    };
    if (!this.connected || !this.client) {
      if (this.loadedClient) {
        this.loadedClient = null;
        this.hydrationToken = null;
        this.clearRefreshTimer();
        stopCodexSessionsPolling(this.controllerHost);
      }
      return;
    }
    if (this.connected && this.client && this.loadedClient !== this.client) {
      if (this.loadedClient) {
        this.hydrationToken = null;
        this.clearRefreshTimer();
        stopCodexSessionsPolling(this.controllerHost);
        sessionsState.requestUpdate = () => {
          this.revision += 1;
        };
      }
      this.loadedClient = this.client;
      this.beginRefresh();
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      globalThis.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private beginRefresh(): void {
    this.clearRefreshTimer();
    this.truncatedHostIds = new Set();
    const token = {};
    this.hydrationToken = token;
    void this.loadAllPages(token).finally(() => {
      if (this.hydrationToken !== token || !this.loadedClient) {
        return;
      }
      this.refreshTimer = globalThis.setTimeout(
        () => this.beginRefresh(),
        SIDEBAR_REFRESH_INTERVAL_MS,
      );
    });
  }

  private async loadAllPages(token: object): Promise<void> {
    const sessionsState = getCodexSessionsState(this.controllerHost);
    const seenCursors = new Set<string>();
    const pageCounts = new Map<string, number>();
    await loadCodexSessions(sessionsState, this.client);
    while (this.hydrationToken === token) {
      const hostIds = sessionsState.hosts
        .filter((host) => {
          const pageCount = pageCounts.get(host.hostId) ?? 1;
          const reachedBudget =
            pageCount >= MAX_CATALOG_PAGES_PER_HOST ||
            host.sessions.length >= MAX_CATALOG_SESSIONS_PER_HOST;
          if (host.nextCursor && reachedBudget) {
            this.truncatedHostIds = new Set(this.truncatedHostIds).add(host.hostId);
            return false;
          }
          const cursorKey = `${host.hostId}\u0000${host.nextCursor ?? ""}`;
          if (!host.connected || host.error || !host.nextCursor || seenCursors.has(cursorKey)) {
            return false;
          }
          seenCursors.add(cursorKey);
          return true;
        })
        .map((host) => host.hostId);
      if (hostIds.length === 0) {
        return;
      }
      await Promise.all(
        hostIds.map(async (hostId) => {
          await loadMoreCodexSessions(sessionsState, this.client, hostId);
          pageCounts.set(hostId, (pageCounts.get(hostId) ?? 1) + 1);
        }),
      );
    }
  }

  private sessionSearch(hostId: string, threadId: string): string {
    return pluginTabSearch({ pluginId: "codex", id: "sessions", hostId, threadId });
  }

  override render() {
    void this.revision;
    const sessionsState = getCodexSessionsState(this.controllerHost);
    const hosts = sessionsState.hosts.filter((host) => host.sessions.length > 0);
    if (!this.connected || (sessionsState.error && hosts.length === 0)) {
      return nothing;
    }
    return html`
      <section class="sidebar-codex-sessions" aria-label=${t("codexSessions.sidebar.title")}>
        <div class="sidebar-recent-sessions__head sidebar-recent-sessions__head--root">
          <span class="sidebar-recent-sessions__label-text"
            >${t("codexSessions.sidebar.title")}</span
          >
          <button
            type="button"
            class="sidebar-session-sort"
            title=${t("codexSessions.sidebar.viewAll")}
            aria-label=${t("codexSessions.sidebar.viewAll")}
            @click=${() => this.onViewAll?.()}
          >
            ${icons.terminal}
          </button>
        </div>
        ${hosts.map(
          (host) => html`
            <div class="sidebar-recent-sessions__group" data-codex-host-id=${host.hostId}>
              <div class="sidebar-recent-sessions__head">
                <span class="sidebar-recent-sessions__label-text">${host.label}</span>
                <span class="sidebar-session-group-count">${host.sessions.length}</span>
              </div>
              ${this.truncatedHostIds.has(host.hostId)
                ? html`<div class="sidebar-codex-sessions__truncated">
                    ${t("codexSessions.sidebar.truncated")}
                  </div>`
                : nothing}
              <div class="sidebar-recent-sessions__list">
                ${host.sessions.map((session) => {
                  const active =
                    this.selectedHostId === host.hostId &&
                    this.selectedThreadId === session.threadId;
                  const search = this.sessionSearch(host.hostId, session.threadId);
                  return html`
                    <a
                      href=${`${this.basePath}/plugin${search}`}
                      class="sidebar-recent-session ${active
                        ? "sidebar-recent-session--active"
                        : ""}"
                      data-codex-thread-id=${session.threadId}
                      title=${sessionTitle(session)}
                      @click=${(event: MouseEvent) => {
                        if (
                          event.button !== 0 ||
                          event.metaKey ||
                          event.ctrlKey ||
                          event.shiftKey
                        ) {
                          return;
                        }
                        event.preventDefault();
                        this.onOpenSession?.(host.hostId, session.threadId);
                      }}
                    >
                      <span class="sidebar-recent-session__body">
                        <span class="sidebar-recent-session__name">${sessionTitle(session)}</span>
                      </span>
                      <span class="session-row-trail">${sessionTimestamp(session)}</span>
                    </a>
                  `;
                })}
              </div>
            </div>
          `,
        )}
      </section>
    `;
  }
}

if (!customElements.get("openclaw-codex-sidebar")) {
  customElements.define("openclaw-codex-sidebar", CodexSidebar);
}
