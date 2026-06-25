import { consume } from "@lit/context";
import { html, LitElement } from "lit";
import { state } from "lit/decorators.js";
import type {
  AgentIdentityResult,
  SessionCompactionCheckpoint,
  SessionsListResult,
} from "../../api/types.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { parseAgentSessionKey } from "../../lib/session-key.ts";
import { filterSessionRows, scopedAgentParamsForSession } from "../../lib/sessions/index.ts";
import { renderSessions } from "./view.ts";

function parseFilterInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export class SessionsPage extends LitElement {
  @consume({ context: applicationContext, subscribe: false })
  private context?: ApplicationContext;

  @state() private result: SessionsListResult | null = null;
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private agentIdentityById: Record<string, AgentIdentityResult> = {};
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

  private stopSessionSubscription?: () => void;
  private sessionRequestId = 0;
  private identityRequestId = 0;
  private checkpointRequestId = 0;

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
    this.stopSessionSubscription?.();
    this.stopSessionSubscription = undefined;
    this.sessionRequestId += 1;
    this.identityRequestId += 1;
    this.checkpointRequestId += 1;
    super.disconnectedCallback();
  }

  private startSessionState() {
    const context = this.context;
    if (!context || this.stopSessionSubscription) {
      return;
    }
    this.stopSessionSubscription = context.sessions.subscribe((state) => {
      if (!state.loading) {
        void this.loadSessions();
      }
    });
    void this.loadSessions();
  }

  private sessionAgentId(key: string): string | undefined {
    const context = this.context;
    if (!context) {
      return undefined;
    }
    const { agentId } = scopedAgentParamsForSession(
      {
        assistantAgentId: context.agentSelection.state.selectedId,
        hello: context.gateway.snapshot.hello,
      },
      key,
    );
    return agentId;
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

  private async loadSessions() {
    const context = this.context;
    if (!context) {
      return;
    }
    const requestId = ++this.sessionRequestId;
    const previous = this.result;
    this.loading = true;
    this.error = null;
    try {
      const result = await context.sessions.list(this.sessionListOptions());
      if (requestId !== this.sessionRequestId) {
        return;
      }
      this.result = result ? filterSessionRows(result, { showArchived: this.showArchived }) : null;
      void this.loadAgentIdentities(this.result);
      const checkpointKey = this.reconcileCheckpointCache(previous, this.result);
      if (checkpointKey) {
        void this.loadCheckpoint(checkpointKey);
      }
    } catch (error) {
      if (requestId === this.sessionRequestId) {
        this.error = String(error);
      }
    } finally {
      if (requestId === this.sessionRequestId) {
        this.loading = false;
      }
    }
  }

  private async loadAgentIdentities(result: SessionsListResult | null) {
    const context = this.context;
    if (!context || !result) {
      this.identityRequestId += 1;
      this.agentIdentityById = {};
      return;
    }
    const agentIds = [
      ...new Set(
        result.sessions
          .map((row) => parseAgentSessionKey(row.key)?.agentId)
          .filter((agentId): agentId is string => Boolean(agentId)),
      ),
    ].filter((agentId) => !this.agentIdentityById[agentId]);
    if (agentIds.length === 0) {
      return;
    }
    const requestId = ++this.identityRequestId;
    const identities = await context.agentIdentity.getMany(agentIds);
    if (requestId !== this.identityRequestId || this.context !== context) {
      return;
    }
    this.agentIdentityById = { ...this.agentIdentityById, ...identities };
  }

  private reconcileCheckpointCache(
    previous: SessionsListResult | null,
    result: SessionsListResult | null,
  ): string | null {
    const rows = new Map((result?.sessions ?? []).map((row) => [row.key, row] as const));
    const previousRows = new Map((previous?.sessions ?? []).map((row) => [row.key, row] as const));
    const nextItems = { ...this.checkpointItemsByKey };
    const nextErrors = { ...this.checkpointErrorByKey };
    let checkpointKey: string | null = null;
    for (const key of Object.keys(nextItems)) {
      const row = rows.get(key);
      const previousRow = previousRows.get(key);
      if (
        !row ||
        !previousRow ||
        previousRow.compactionCheckpointCount !== row.compactionCheckpointCount ||
        previousRow.latestCompactionCheckpoint?.checkpointId !==
          row.latestCompactionCheckpoint?.checkpointId
      ) {
        delete nextItems[key];
        delete nextErrors[key];
        if (this.expandedCheckpointKey === key) {
          checkpointKey = key;
        }
      }
    }
    this.checkpointItemsByKey = nextItems;
    this.checkpointErrorByKey = nextErrors;
    return checkpointKey;
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
    void this.loadSessions();
  }

  private async deleteSelected() {
    const context = this.context;
    const keys = [...this.selectedKeys];
    if (!context || keys.length === 0 || this.loading) {
      return;
    }
    if (
      !window.confirm(
        `Delete ${keys.length} ${keys.length === 1 ? "session" : "sessions"}?\n\nThis will delete the session entries and archive their transcripts.`,
      )
    ) {
      return;
    }
    const deleted: string[] = [];
    const result = await context.sessions.deleteMany(
      keys.map((key) => ({
        key,
        agentId: this.sessionAgentId(key),
      })),
    );
    deleted.push(...result.deleted);
    if (deleted.length > 0) {
      const selected = new Set(this.selectedKeys);
      for (const key of deleted) {
        selected.delete(key);
      }
      this.selectedKeys = selected;
      await this.loadSessions();
    }
    if (result.errors.length > 0) {
      this.error = result.errors.join("; ");
    }
  }

  private async toggleCheckpointDetails(sessionKey: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    if (this.expandedCheckpointKey === sessionKey) {
      this.checkpointRequestId += 1;
      this.expandedCheckpointKey = null;
      return;
    }
    this.expandedCheckpointKey = sessionKey;
    if (this.checkpointItemsByKey[sessionKey]) {
      return;
    }
    await this.loadCheckpoint(sessionKey);
  }

  private async loadCheckpoint(sessionKey: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    const requestId = ++this.checkpointRequestId;
    this.checkpointLoadingKey = sessionKey;
    this.checkpointErrorByKey = { ...this.checkpointErrorByKey, [sessionKey]: "" };
    try {
      const checkpoints = await context.sessions.listCheckpoints(sessionKey, {
        agentId: this.sessionAgentId(sessionKey),
      });
      if (requestId !== this.checkpointRequestId) {
        return;
      }
      this.checkpointItemsByKey = { ...this.checkpointItemsByKey, [sessionKey]: checkpoints };
    } catch (error) {
      if (requestId !== this.checkpointRequestId) {
        return;
      }
      this.checkpointErrorByKey = {
        ...this.checkpointErrorByKey,
        [sessionKey]: String(error),
      };
    } finally {
      if (requestId === this.checkpointRequestId && this.checkpointLoadingKey === sessionKey) {
        this.checkpointLoadingKey = null;
      }
    }
  }

  private async branchCheckpoint(sessionKey: string, checkpointId: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    if (!window.confirm("Create a new child session from this compacted checkpoint?")) {
      return;
    }
    this.checkpointBusyKey = checkpointId;
    try {
      const result = await context.sessions.branchCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey),
      });
      await this.loadSessions();
      context.navigate("chat", { search: `?session=${encodeURIComponent(result.key)}` });
    } catch (error) {
      this.error = String(error);
    } finally {
      if (this.checkpointBusyKey === checkpointId) {
        this.checkpointBusyKey = null;
      }
    }
  }

  private async restoreCheckpoint(sessionKey: string, checkpointId: string) {
    const context = this.context;
    if (!context) {
      return;
    }
    if (
      !window.confirm(
        "Restore this session to the selected compacted checkpoint?\n\nThis replaces the current active transcript for the session key.",
      )
    ) {
      return;
    }
    this.checkpointBusyKey = checkpointId;
    try {
      await context.sessions.restoreCheckpoint(sessionKey, checkpointId, {
        agentId: this.sessionAgentId(sessionKey),
      });
      await this.loadSessions();
    } catch (error) {
      this.error = String(error);
    } finally {
      if (this.checkpointBusyKey === checkpointId) {
        this.checkpointBusyKey = null;
      }
    }
  }

  override render() {
    const context = this.context;
    if (!context) {
      return html``;
    }
    return renderSessions({
      loading: this.loading,
      result: this.result,
      error: this.error,
      activeMinutes: this.activeMinutes,
      limit: this.limit,
      includeGlobal: this.includeGlobal,
      includeUnknown: this.includeUnknown,
      showArchived: this.showArchived,
      filtersCollapsed: this.filtersCollapsed,
      basePath: context.basePath,
      searchQuery: this.searchQuery,
      agentIdentityById: this.agentIdentityById,
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
        void this.loadSessions();
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
      onRefresh: () => void this.loadSessions(),
      onPatch: (key, patch) => {
        void context.sessions
          .patch(key, patch, {
            agentId: this.sessionAgentId(key),
          })
          .then(async () => {
            await this.loadSessions();
          })
          .catch((error: unknown) => {
            this.error = String(error);
          });
      },
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
