import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { serializeSidebarEntry } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import {
  DASHBOARD_DOCUMENT_ELEMENT,
  ensureCustomElementDefined,
} from "../../app/lazy-custom-element.ts";
import type { SidebarSessionMutationScope } from "../../components/app-sidebar-session-types.ts";
import { sessionMenuReasons } from "../../components/session-menu-access.ts";
import type {
  SessionActionHost,
  SessionActionRow,
} from "../../components/session-organizer-operations.runtime.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { canArchiveSessionRow, canDeleteSessionRows } from "../../lib/sessions/session-key.ts";
import { dashboardSessionListQuery } from "../../lib/sessions/session-requests.ts";
import { showToast } from "../../lib/toast.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import type { DashboardCardMenuAction } from "./dashboard-card-menu.ts";
import "./dashboard-card-menu.ts";
import { dashboardsRouteData } from "./route.ts";
import {
  renderDashboards,
  type DashboardGalleryFilters,
  type DashboardRow,
  type DashboardsRouteData,
} from "./view.ts";

type DashboardCardMenuState = { key: string; sessionId?: string; x: number; y: number };

/** Same running fact the sidebar derives, so card Delete follows the sidebar's gate. */
function dashboardRunActive(row: DashboardRow): boolean {
  return row.archived !== true && isSessionRunActive(row);
}

class DashboardsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property({ attribute: false }) routeData?: DashboardsRouteData;

  @state() private filters: DashboardGalleryFilters = {
    query: "",
    ownerId: "",
    sort: "updated",
    // Session maintenance archives idle dashboards (archiveDashboardAfter, 7d by
    // default), so the gallery keeps listing them unless the operator narrows it.
    status: "all",
  };
  @state() private previewError: string | null = null;
  @state() private cardMenu: DashboardCardMenuState | null = null;

  private cardMenuTrigger: HTMLElement | null = null;
  // Retired on disconnect so a confirmation left open cannot act for a detached gallery.
  private cardActionEpoch = 0;
  private cardActionLifetime = new AbortController();
  private cardOperationsLoad: Promise<
    typeof import("../../components/session-organizer-operations.runtime.ts")
  > | null = null;

  private observedSessions?: ApplicationContext["sessions"];
  private observedScopeId?: string | null;
  private unsubscribeList?: () => void;
  private data?: DashboardsRouteData;
  private readonly subscriptions = new SubscriptionsController(this).effect(
    () => this.context?.agentSelection,
    (agentSelection) => {
      this.bindList();
      return agentSelection.subscribe(() => this.bindList());
    },
  );

  override connectedCallback() {
    super.connectedCallback();
    void ensureCustomElementDefined(
      DASHBOARD_DOCUMENT_ELEMENT.tagName,
      DASHBOARD_DOCUMENT_ELEMENT.loadModule,
    )
      .then(() => this.requestUpdate())
      .catch((error: unknown) => {
        this.previewError = formatUiError(error);
      });
  }

  override disconnectedCallback() {
    this.closeCardMenu();
    this.cardActionEpoch += 1;
    this.cardActionLifetime.abort();
    this.cardActionLifetime = new AbortController();
    this.unsubscribeList?.();
    this.unsubscribeList = undefined;
    this.observedSessions = undefined;
    this.observedScopeId = undefined;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has("routeData")) {
      this.data = this.routeData;
    }
    this.bindList();
  }

  private bindList(): void {
    const context = this.context;
    if (!context) {
      return;
    }
    const sessions = context.sessions;
    const scopeId = context.agentSelection.state.scopeId?.trim() || null;
    if (sessions === this.observedSessions && scopeId === this.observedScopeId) {
      return;
    }
    this.unsubscribeList?.();
    this.observedSessions = sessions;
    this.observedScopeId = scopeId;
    const query = dashboardSessionListQuery(context.agentSelection.state.scopeId);
    const apply = (snapshot: ReturnType<typeof sessions.listSnapshot>) => {
      if (
        this.context !== context ||
        this.observedSessions !== sessions ||
        this.observedScopeId !== scopeId ||
        (!snapshot.result && !snapshot.error && this.data?.result)
      ) {
        return;
      }
      this.data = dashboardsRouteData(context, snapshot);
      this.requestUpdate();
      if (snapshot.result?.hasMore && !snapshot.loading && !snapshot.error) {
        void sessions.refreshList({
          ...query,
          append: true,
          offset: snapshot.result.nextOffset ?? snapshot.result.sessions.length,
        });
      }
    };
    this.unsubscribeList = sessions.subscribeList(query, apply);
    const snapshot = sessions.listSnapshot(query);
    apply(snapshot);
    if (!snapshot.result && !snapshot.loading && context.gateway.snapshot.phase === "connected") {
      void sessions.refreshList(query);
    }
  }

  private openCardMenu(
    row: DashboardRow,
    position: { x: number; y: number },
    trigger: HTMLElement | null,
  ) {
    if (this.cardMenu?.key === row.key && this.cardMenu.sessionId === row.sessionId) {
      this.closeCardMenu();
      return;
    }
    this.cardMenu = { key: row.key, sessionId: row.sessionId, ...position };
    this.cardMenuTrigger = trigger;
  }

  private closeCardMenu() {
    this.cardMenu = null;
    this.cardMenuTrigger = null;
  }

  private captureCardActionScope(): SidebarSessionMutationScope | null {
    const context = this.context;
    const gateway = context?.gateway;
    const client = gateway?.snapshot.client;
    if (!context || !gateway || gateway.snapshot.phase !== "connected" || !client) {
      return null;
    }
    return {
      epoch: this.cardActionEpoch,
      context,
      gateway,
      sessions: context.sessions,
      client,
      selectedAgentId: context.agentSelection.state.selectedId ?? "main",
      signal: this.cardActionLifetime.signal,
    };
  }

  private isCardActionScopeCurrent(scope: SidebarSessionMutationScope): boolean {
    return (
      this.isConnected &&
      scope.epoch === this.cardActionEpoch &&
      this.context === scope.context &&
      scope.context.gateway === scope.gateway &&
      scope.context.sessions === scope.sessions &&
      scope.gateway.snapshot.phase === "connected" &&
      scope.gateway.snapshot.client === scope.client
    );
  }

  /** Card actions reuse the shared session lifecycle operations, so the gallery
   *  keeps the same confirmation, access, workspace-recovery, and undo contract
   *  as the sidebar and chat header. */
  private async runCardAction(row: DashboardRow, action: DashboardCardMenuAction) {
    const scope = this.captureCardActionScope();
    if (!scope) {
      showToast({ message: t("sessionsView.actionRequiresConnection") });
      return;
    }
    const publishError = (error: unknown) => {
      showToast({ message: formatUiError(error) });
    };
    const host: SessionActionHost = {
      sessionData: {
        isSessionMutationScopeCurrent: (candidate) => this.isCardActionScopeCurrent(candidate),
        publishSessionMutationError: (candidate, error) => {
          if (this.isCardActionScopeCurrent(candidate)) {
            publishError(error);
          }
        },
        refreshSidebarSessions: async (agentId) => {
          const outcome = await scope.sessions.reconcileMutation(agentId);
          if (outcome.status === "failed" && this.isCardActionScopeCurrent(scope)) {
            publishError(outcome.error);
          }
        },
      },
      pruneSidebarSessionEntry: (key) => {
        const entry = serializeSidebarEntry({ type: "session", key });
        const sidebarEntries = scope.context.navigation.snapshot.sidebarEntries.filter(
          (candidate) => candidate !== entry,
        );
        scope.context.navigation.update({ sidebarEntries });
      },
      // The gallery never changes the selected conversation.
      selectSession: () => {},
      // Row events keep the gallery current; the list needs no extra read.
      sidebarSessionStatusFilter: () => "active",
    };
    const session: SessionActionRow = {
      key: row.key,
      agentId: row.agentId,
      sessionId: row.sessionId,
      sharingRole: row.sharingRole,
      label: resolveSessionDisplayName(row.key, row),
      pinned: row.pinned === true,
      archived: row.archived === true,
      category: row.category,
      active: false,
      hasActiveRun: dashboardRunActive(row),
      gatewayHasActiveRun: row.hasActiveRun,
    };
    try {
      // A failed chunk load clears the cache so the next action retries it.
      const operations = await (this.cardOperationsLoad ??=
        import("../../components/session-organizer-operations.runtime.ts").catch(
          (error: unknown) => {
            this.cardOperationsLoad = null;
            throw error;
          },
        ));
      if (!this.isCardActionScopeCurrent(scope)) {
        return;
      }
      if (action === "delete") {
        await operations.deleteSession(host, session, scope);
      } else if (session.archived) {
        await operations.patchSession(host, session, { archived: false }, scope, {
          sessionScope: true,
        });
      } else {
        await operations.archiveSessionWithUndo(host, session, scope);
      }
    } catch (error) {
      if (this.isCardActionScopeCurrent(scope)) {
        publishError(error);
      }
    }
  }

  private renderCardMenu() {
    const menu = this.cardMenu;
    const context = this.context;
    const data = this.data;
    const row = menu
      ? data?.result?.sessions.find(
          (session) => session.key === menu.key && session.sessionId === menu.sessionId,
        )
      : undefined;
    if (!menu || !context || !data || !row) {
      return nothing;
    }
    // Lifecycle policy omits an action, as in the sidebar; missing access disables it with a reason.
    const reasons = sessionMenuReasons({ snapshot: context.gateway.snapshot, session: row });
    // Keyed like the sidebar menu: a replaced menu's late hide must not close its successor.
    return keyed(
      menu,
      html`<openclaw-dashboard-card-menu
        .x=${menu.x}
        .y=${menu.y}
        .trigger=${this.cardMenuTrigger}
        .archived=${row.archived === true}
        .archiving=${context.sessions.archiveVisibility(row.key) === "pending"}
        .archiveAllowed=${canArchiveSessionRow(row, data.mainKey)}
        .deleteAllowed=${canDeleteSessionRows(
          [{ ...row, hasActiveRun: dashboardRunActive(row) }],
          data.mainKey,
        )}
        .archiveDisabledReason=${reasons["toggle-archived"] ?? null}
        .deleteDisabledReason=${reasons.delete ?? null}
        .onAction=${(action: DashboardCardMenuAction) => void this.runCardAction(row, action)}
        .onClose=${() => this.closeCardMenu()}
      ></openclaw-dashboard-card-menu>`,
    );
  }

  override render() {
    return html`${renderDashboards(
      this.data,
      this.filters,
      {
        onQueryChange: (query) => {
          this.filters = { ...this.filters, query };
        },
        onOwnerChange: (ownerId) => {
          this.filters = { ...this.filters, ownerId };
        },
        onSortChange: (sort) => {
          this.filters = { ...this.filters, sort };
        },
        onStatusChange: (status) => {
          this.filters = { ...this.filters, status };
        },
        onNavigate: this.context?.navigate,
        onOpenCardMenu: (row, position, trigger) => this.openCardMenu(row, position, trigger),
        openCardMenuKey: this.cardMenu?.key ?? null,
      },
      this.context?.gateway.snapshot,
      this.previewError,
    )}${this.renderCardMenu()}`;
  }
}

if (!customElements.get("openclaw-dashboards-page")) {
  customElements.define("openclaw-dashboards-page", DashboardsPage);
}
