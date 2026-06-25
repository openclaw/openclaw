import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type { SessionCompactionCheckpoint } from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { parseAgentSessionKey } from "../../lib/session-key.ts";
import type { SessionSnapshot } from "../../lib/sessions/index.ts";
import { renderSessions } from "./view.ts";

function parseFilterInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export class SessionsPage extends LitElement {
  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext;

  @state() private snapshot: SessionSnapshot = {
    result: null,
    agentId: null,
    loading: false,
    error: null,
  };
  @state() private activeMinutes = "60";
  @state() private limit = "50";
  @state() private includeGlobal = true;
  @state() private includeUnknown = false;
  @state() private showArchived = false;
  @state() private filtersCollapsed = false;
  @state() private searchQuery = "";
  @state() private sortColumn: "key" | "kind" | "updated" | "tokens" = "updated";
  @state() private sortDir: "asc" | "desc" = "desc";
  @state() private page = 0;
  @state() private pageSize = 25;
  @state() private selectedKeys = new Set<string>();
  @state() private expandedCheckpointKey: string | null = null;
  @state() private checkpointItemsByKey: Record<string, SessionCompactionCheckpoint[]> = {};
  @state() private checkpointLoadingKey: string | null = null;
  @state() private checkpointBusyKey: string | null = null;
  @state() private checkpointErrorByKey: Record<string, string> = {};

  private stopSessionsSubscription?: () => void;

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.startSessionState();
  }

  override updated() {
    this.startSessionState();
  }

  override disconnectedCallback() {
    this.stopSessionsSubscription?.();
    this.stopSessionsSubscription = undefined;
    super.disconnectedCallback();
  }

  private startSessionState() {
    const context = this.context;
    if (!context || this.stopSessionsSubscription) {
      return;
    }
    this.snapshot = context.sessions.snapshot;
    this.stopSessionsSubscription = context.sessions.subscribe((snapshot) => {
      this.snapshot = snapshot;
    });
    void this.refreshSessions();
  }

  private sessionAgentId(key: string): string | undefined {
    const parsed = parseAgentSessionKey(key);
    if (parsed?.agentId) {
      return parsed.agentId;
    }
    return key === "global"
      ? (this.context?.gateway.snapshot.assistantAgentId ?? undefined)
      : undefined;
  }

  private sessionListOptions() {
    return {
      activeMinutes: this.showArchived ? 0 : parseFilterInteger(this.activeMinutes),
      limit: parseFilterInteger(this.limit),
      includeGlobal: this.includeGlobal,
      includeUnknown: this.includeUnknown,
      showArchived: this.showArchived,
    };
  }

  private async refreshSessions() {
    await this.context?.sessions.refresh({
      ...this.sessionListOptions(),
      force: true,
    });
  }

  private updateFilters(next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
    showArchived: boolean;
  }) {
    this.activeMinutes = next.activeMinutes;
    this.limit = next.limit;
    this.includeGlobal = next.includeGlobal;
    this.includeUnknown = next.includeUnknown;
    this.showArchived = next.showArchived;
    this.page = 0;
    this.selectedKeys = new Set();
    void this.refreshSessions();
  }

  private async deleteSelected() {
    const context = this.context;
    if (!context || this.selectedKeys.size === 0) {
      return;
    }
    for (const key of this.selectedKeys) {
      await context.sessions.delete(key, { agentId: this.sessionAgentId(key) });
    }
    this.selectedKeys = new Set();
  }

  private async toggleCheckpointDetails(sessionKey: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    if (this.expandedCheckpointKey === sessionKey) {
      this.expandedCheckpointKey = null;
      return;
    }
    this.expandedCheckpointKey = sessionKey;
    this.checkpointLoadingKey = sessionKey;
    this.checkpointErrorByKey = { ...this.checkpointErrorByKey, [sessionKey]: "" };
    try {
      const checkpoints = await context.sessions.listCheckpoints(sessionKey, {
        agentId: this.sessionAgentId(sessionKey),
      });
      this.checkpointItemsByKey = { ...this.checkpointItemsByKey, [sessionKey]: checkpoints };
    } catch (error) {
      this.checkpointErrorByKey = {
        ...this.checkpointErrorByKey,
        [sessionKey]: String(error),
      };
    } finally {
      if (this.checkpointLoadingKey === sessionKey) {
        this.checkpointLoadingKey = null;
      }
    }
  }

  private async branchCheckpoint(sessionKey: string, checkpointId: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    this.checkpointBusyKey = sessionKey;
    try {
      const result = await context.sessions.branchCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey),
      });
      context.navigate("chat", { search: `?session=${encodeURIComponent(result.key)}` });
    } finally {
      this.checkpointBusyKey = null;
    }
  }

  private async restoreCheckpoint(sessionKey: string, checkpointId: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    this.checkpointBusyKey = sessionKey;
    try {
      await context.sessions.restoreCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey),
      });
      await this.refreshSessions();
    } finally {
      this.checkpointBusyKey = null;
    }
  }

  override render() {
    const context = this.context;
    if (!context) {
      return html``;
    }
    return renderSessions({
      loading: this.snapshot.loading,
      result: this.snapshot.result,
      error: this.snapshot.error,
      activeMinutes: this.activeMinutes,
      limit: this.limit,
      includeGlobal: this.includeGlobal,
      includeUnknown: this.includeUnknown,
      showArchived: this.showArchived,
      filtersCollapsed: this.filtersCollapsed,
      basePath: context.basePath,
      searchQuery: this.searchQuery,
      agentIdentityById: {},
      sortColumn: this.sortColumn,
      sortDir: this.sortDir,
      page: this.page,
      pageSize: this.pageSize,
      selectedKeys: this.selectedKeys,
      expandedCheckpointKey: this.expandedCheckpointKey,
      checkpointItemsByKey: this.checkpointItemsByKey,
      checkpointLoadingKey: this.checkpointLoadingKey,
      checkpointBusyKey: this.checkpointBusyKey,
      checkpointErrorByKey: this.checkpointErrorByKey,
      onFiltersChange: (next) => this.updateFilters(next),
      onToggleFiltersCollapsed: () => {
        this.filtersCollapsed = !this.filtersCollapsed;
      },
      onClearFilters: () => {
        this.activeMinutes = "";
        this.limit = "";
        this.includeGlobal = true;
        this.includeUnknown = true;
        this.showArchived = true;
        this.searchQuery = "";
        this.page = 0;
        this.selectedKeys = new Set();
        void this.refreshSessions();
      },
      onSearchChange: (query) => {
        this.searchQuery = query;
        this.page = 0;
      },
      onSortChange: (column, direction) => {
        this.sortColumn = column;
        this.sortDir = direction;
        this.page = 0;
      },
      onPageChange: (page) => {
        this.page = page;
      },
      onPageSizeChange: (pageSize) => {
        this.pageSize = pageSize;
        this.page = 0;
      },
      onRefresh: () => void this.refreshSessions(),
      onPatch: (key, patch) =>
        void context.sessions.patch(key, patch, { agentId: this.sessionAgentId(key) }),
      onToggleSelect: (key) => {
        const next = new Set(this.selectedKeys);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        this.selectedKeys = next;
      },
      onSelectPage: (keys) => {
        this.selectedKeys = new Set([...this.selectedKeys, ...keys]);
      },
      onDeselectPage: (keys) => {
        const next = new Set(this.selectedKeys);
        for (const key of keys) {
          next.delete(key);
        }
        this.selectedKeys = next;
      },
      onDeselectAll: () => {
        this.selectedKeys = new Set();
      },
      onDeleteSelected: () => void this.deleteSelected(),
      onNavigateToChat: (sessionKey) =>
        context.navigate("chat", { search: `?session=${encodeURIComponent(sessionKey)}` }),
      onToggleCheckpointDetails: (sessionKey) => void this.toggleCheckpointDetails(sessionKey),
      onBranchFromCheckpoint: (sessionKey, checkpointId) =>
        void this.branchCheckpoint(sessionKey, checkpointId),
      onRestoreCheckpoint: (sessionKey, checkpointId) =>
        void this.restoreCheckpoint(sessionKey, checkpointId),
    });
  }
}

if (!customElements.get("openclaw-sessions-page")) {
  customElements.define("openclaw-sessions-page", SessionsPage);
}
