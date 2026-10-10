import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteLocation } from "@openclaw/uirouter";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayEventFrame,
} from "../../api/gateway.ts";
import { activityPersonFromPath } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { readPresenceEntries, type PresencePayload } from "../../app/user-profile.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { canCallGatewayMethod, isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { projectPresencePayload } from "../../lib/presence-users.ts";
import { readSessionChangedEvent } from "../../lib/sessions/reconcile.ts";
import { createLiveActivity } from "./live-activity.ts";
import {
  activityRunInspectorSearch,
  mergeDecisionPage,
  receiptPageCursors,
  resolveActivityRouteData,
  type ActivityRouteData,
  type RunInspectorSelector,
  type RunInspectorState,
} from "./run-inspector-model.ts";
import {
  ACTIVITY_SUMMARY_ENSURE_METHOD,
  SessionActivityController,
} from "./session-activity-controller.ts";
import type { ActivityEntry, ActivityStatus } from "./tool-activity.ts";

function inspectorRequestKey(route: ActivityRouteData | undefined): string | null {
  if (route?.mode !== "run" || !route.selector) {
    return null;
  }
  return `${route.selector.kind}:${route.selector.id}:${route.decisionCursor ?? ""}`;
}

function isExpiredDecisionCursorError(error: unknown): boolean {
  const record = asRecord(error);
  return (
    (record?.gatewayCode === "INVALID_REQUEST" || record?.code === "INVALID_REQUEST") &&
    record.retryable !== true
  );
}

export class ActivityPageController {
  context!: ApplicationContext;
  routeLocation?: RouteLocation;
  routeData?: ActivityRouteData;
  presentedRoute?: { location: RouteLocation; data: ActivityRouteData };

  entries: readonly ActivityEntry[] = [];
  filterText = "";
  statusFilters: Record<ActivityStatus, boolean> = {
    running: true,
    done: true,
    error: true,
  };
  toolFilter = "";
  expandedIds = new Set<string>();
  expandedAutomationDays = new Set<string>();
  autoFollow = true;
  runInspector: RunInspectorState = { status: "empty" };
  presencePayload: PresencePayload | undefined;
  liveActivity: ReturnType<typeof createLiveActivity> | null = null;
  private liveActivityRevision = -1;
  readonly sessionActivity = new SessionActivityController(() => this.requestUpdate());
  private sessionActivityRevision = -1;
  private inspectorAbort: AbortController | null = null;
  private inspectorClient: GatewayBrowserClient | null = null;
  private inspectorEpoch = 0;
  private inspectorSelectorKey: string | null = null;
  private presenceClient: GatewayBrowserClient | null = null;
  atBottom = true;
  private connected = false;
  private cleanup?: () => void;

  constructor(private readonly notify: () => void) {}

  connect(context: ApplicationContext) {
    if (this.connected && this.context === context) {
      return;
    }
    this.dispose();
    this.context = context;
    this.connected = true;
    this.sessionActivity.connect();
    const gateway = context.gateway;
    const activity = createLiveActivity(gateway, context.sessions);
    this.liveActivity = activity;
    this.entries = [];
    this.expandedIds = new Set();
    const stopActivity = activity.subscribe((snapshot) => {
      this.entries = snapshot.entries;
      if (snapshot.revision !== this.liveActivityRevision) {
        this.liveActivityRevision = snapshot.revision;
        this.expandedIds = new Set();
        this.atBottom = true;
      }
      this.requestUpdate();
    });
    const stopAgents = context.agents.subscribe(() => this.requestUpdate());
    this.applyGatewaySnapshot(gateway, gateway.snapshot, true);
    const stopEvents = gateway.subscribeEvents((event) => this.applyGatewayEvent(gateway, event));
    const stopGateway = gateway.subscribe((snapshot) =>
      this.applyGatewaySnapshot(gateway, snapshot, false),
    );
    this.cleanup = () => {
      stopActivity();
      activity.dispose();
      this.liveActivity = null;
      stopAgents();
      stopGateway();
      stopEvents();
    };
  }

  setRouteLocation(location: RouteLocation | undefined) {
    this.routeLocation = location;
    this.routeData = location
      ? resolveActivityRouteData(
          location.search,
          activityPersonFromPath(location.pathname, this.context.basePath),
        )
      : undefined;
    if (location && this.routeData) {
      this.presentedRoute = { location, data: this.routeData };
    }
    this.syncSessionActivity();
    this.bindInspectorRoute();
    this.requestUpdate();
  }

  requestUpdate() {
    if (!this.connected) {
      return;
    }
    this.liveActivity?.syncSessions(
      this.routeData?.mode === "live" ? (this.sessionActivity.result?.sessions ?? []) : [],
    );
    const canonical = this.routeLocation
      ? this.sessionActivity.canonicalLocation(
          this.routeLocation,
          this.context.basePath,
          projectPresencePayload(this.presencePayload).users,
        )
      : null;
    if (canonical) {
      this.context.replace("activity", canonical);
    }
    this.notify();
  }

  dispose() {
    this.connected = false;
    this.cleanup?.();
    this.cleanup = undefined;
    this.cancelInspectorRequest();
    this.sessionActivity.dispose();
    this.presentedRoute = undefined;
  }

  private applyGatewaySnapshot(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    sourceChanged: boolean,
  ) {
    if (sourceChanged || gateway.eventLogRevision !== this.sessionActivityRevision) {
      this.sessionActivityRevision = gateway.eventLogRevision;
      this.presentedRoute = undefined;
      void this.sessionActivity.load(null, null);
    }
    if (sourceChanged || snapshot.client !== this.presenceClient) {
      this.presenceClient = snapshot.client;
      const presence =
        snapshot.phase === "connected" ? readPresenceEntries(snapshot.hello?.snapshot) : undefined;
      this.presencePayload = presence ? { presence } : undefined;
    } else if (snapshot.phase !== "connected" && this.presencePayload) {
      this.presencePayload = undefined;
    }
    this.syncRunInspector(gateway, snapshot, sourceChanged);
    this.syncSessionActivity();
    this.requestUpdate();
  }

  syncSessionActivity(reason: "query" | "retry" = "query") {
    const snapshot = this.context?.gateway.snapshot;
    void this.sessionActivity.load(
      snapshot?.phase === "connected" ? snapshot.client : null,
      this.routeData?.mode === "sessions"
        ? this.routeData.filters
        : this.routeData?.mode === "live"
          ? "current"
          : null,
      reason,
      canCallGatewayMethod(snapshot, ACTIVITY_SUMMARY_ENSURE_METHOD, "operator.write", {
        requireAdvertisement: false,
      }),
    );
  }

  private bindInspectorRoute() {
    const route = this.routeData;
    const selector = route?.mode === "run" ? route.selector : null;
    const nextSelectorKey = inspectorRequestKey(route);
    if (nextSelectorKey === this.inspectorSelectorKey && route?.mode === "run") {
      return;
    }
    this.inspectorSelectorKey = nextSelectorKey;
    this.cancelInspectorRequest();
    this.inspectorClient = null;
    this.runInspector = selector
      ? { status: "loading", waitingForGateway: true }
      : { status: "empty" };
    if (route?.mode === "run") {
      this.syncRunInspector(this.context.gateway, this.context.gateway.snapshot, true);
    }
  }

  private cancelInspectorRequest() {
    this.inspectorEpoch += 1;
    this.inspectorAbort?.abort();
    this.inspectorAbort = null;
  }

  syncRunInspector(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    force = false,
  ) {
    const route = this.routeData;
    if (route?.mode !== "run") {
      return;
    }
    const selector = route.selector;
    if (!selector) {
      this.runInspector = { status: "empty" };
      this.requestUpdate();
      return;
    }
    this.inspectorSelectorKey = inspectorRequestKey(route);
    if (snapshot.phase !== "connected" || !snapshot.client) {
      this.cancelInspectorRequest();
      this.inspectorClient = null;
      this.runInspector = { status: "disconnected" };
      this.requestUpdate();
      return;
    }
    const unavailable =
      isGatewayMethodAdvertised(snapshot, "audit.run.inspect") === false
        ? "unsupported"
        : !canCallGatewayMethod(snapshot, "audit.run.inspect", "operator.read")
          ? "unauthorized"
          : null;
    if (unavailable) {
      this.cancelInspectorRequest();
      this.inspectorClient = snapshot.client;
      this.runInspector = { status: unavailable };
      this.requestUpdate();
      return;
    }
    if (
      !force &&
      this.inspectorClient === snapshot.client &&
      (this.runInspector.status === "loading" || this.runInspector.status === "ready")
    ) {
      return;
    }
    void this.loadRunInspector(gateway, snapshot.client, selector);
  }

  private isUnknownInspectMethod(error: unknown): boolean {
    return (
      error instanceof GatewayRequestError &&
      error.gatewayCode === "INVALID_REQUEST" &&
      (error.message === "unknown method: audit.run.inspect" ||
        error.message === "missing scope: operator.admin")
    );
  }

  private async loadRunInspector(
    gateway: ApplicationContext["gateway"],
    client: GatewayBrowserClient,
    selector: RunInspectorSelector,
    previousState?: Extract<RunInspectorState, { status: "ready" }>,
    pageKind: "executions" | "decisions" = "executions",
  ) {
    this.cancelInspectorRequest();
    const epoch = this.inspectorEpoch;
    const abort = new AbortController();
    this.inspectorAbort = abort;
    this.inspectorClient = client;
    const pageStatus = pageKind === "decisions" ? "decisionPageStatus" : "executionPageStatus";
    this.runInspector = previousState
      ? { ...previousState, [pageStatus]: "loading" }
      : { status: "loading", waitingForGateway: false };
    this.requestUpdate();
    const requestSelectorKey = inspectorRequestKey(this.routeData);
    const isCurrent = () =>
      this.inspectorEpoch === epoch &&
      this.context.gateway === gateway &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected" &&
      this.routeData?.mode === "run" &&
      inspectorRequestKey(this.routeData) === requestSelectorKey;
    const decisionCursor =
      pageKind === "decisions"
        ? previousState?.result.nextDecisionCursor
        : this.routeData?.mode === "run"
          ? this.routeData.decisionCursor
          : null;
    try {
      const params = {
        ...(selector.kind === "run"
          ? {
              runId: selector.id,
              executionLimit: 50,
              ...(pageKind === "executions" && previousState?.result.nextExecutionCursor
                ? { executionCursor: previousState.result.nextExecutionCursor }
                : {}),
            }
          : { executionId: selector.id }),
        decisionLimit: 50,
        ...(decisionCursor ? { decisionCursor } : {}),
      };
      let result = await client.request<AuditRunInspectResult>("audit.run.inspect", params, {
        signal: abort.signal,
      });
      if (!isCurrent()) {
        return;
      }
      let cursors: ReturnType<typeof receiptPageCursors>;
      if (previousState && pageKind === "decisions") {
        const merged = mergeDecisionPage(previousState.result, result);
        if (!merged) {
          this.runInspector = { ...previousState, decisionPageStatus: "error" };
          return;
        }
        cursors = new Map([
          ...previousState.receiptPageCursors,
          ...receiptPageCursors(result.decisionDisplays, decisionCursor ?? undefined),
        ]);
        result = merged;
      } else if (
        previousState?.result.identity.state === "ambiguous" &&
        result.identity.state === "ambiguous"
      ) {
        const candidates = new Map(
          [...previousState.result.identity.candidates, ...result.identity.candidates].map(
            (candidate) => [candidate.executionId, candidate],
          ),
        );
        result = {
          ...result,
          identity: { ...result.identity, candidates: [...candidates.values()] },
        };
        cursors = previousState.receiptPageCursors;
      } else {
        cursors = receiptPageCursors(result.decisionDisplays, decisionCursor ?? undefined);
      }
      this.runInspector = { status: "ready", result, receiptPageCursors: cursors };
    } catch (error) {
      if (!isCurrent() || abort.signal.aborted) {
        return;
      }
      this.runInspector = isMissingOperatorReadScopeError(error)
        ? { status: "unauthorized" }
        : this.isUnknownInspectMethod(error)
          ? { status: "unsupported" }
          : previousState
            ? { ...previousState, [pageStatus]: "error" }
            : {
                status: "error",
                recovery:
                  decisionCursor && isExpiredDecisionCursorError(error) ? "restart" : "retry",
              };
    } finally {
      if (this.inspectorAbort === abort) {
        this.inspectorAbort = null;
        this.requestUpdate();
      }
    }
  }

  loadMoreInspectorPage(kind: "executions" | "decisions") {
    const route = this.routeData;
    const gateway = this.context.gateway;
    const snapshot = gateway.snapshot;
    const inspectorState = this.runInspector;
    if (
      route?.mode !== "run" ||
      !route.selector ||
      snapshot.phase !== "connected" ||
      !snapshot.client ||
      inspectorState.status !== "ready"
    ) {
      return;
    }
    const available =
      kind === "executions"
        ? route.selector.kind === "run" &&
          inspectorState.executionPageStatus !== "loading" &&
          inspectorState.result.identity.state === "ambiguous" &&
          inspectorState.result.nextExecutionCursor
        : inspectorState.decisionPageStatus !== "loading" &&
          inspectorState.result.identity.state === "present" &&
          inspectorState.result.nextDecisionCursor;
    if (available) {
      void this.loadRunInspector(gateway, snapshot.client, route.selector, inspectorState, kind);
    }
  }

  restartRunInspector() {
    const route = this.routeData;
    if (route?.mode !== "run" || !route.selector) {
      return;
    }
    this.context.navigate("activity", { search: activityRunInspectorSearch(route.selector) });
  }

  private applyGatewayEvent(gateway: ApplicationContext["gateway"], event: GatewayEventFrame) {
    if (this.context.gateway !== gateway) {
      return;
    }
    const change =
      event.event === "session.message" ? readSessionChangedEvent(event.payload) : null;
    const terminalMessage =
      change &&
      (change.hasActiveRun === false ||
        (change.status !== null && change.status !== "running" && change.status !== "queued"));
    if (
      event.event === "sessions.changed" ||
      (this.routeData?.mode === "live" && terminalMessage)
    ) {
      this.sessionActivity.invalidate(event.payload);
    }
    if (event.event === "presence") {
      const presence = readPresenceEntries(event.payload);
      this.presencePayload = presence ? { presence } : undefined;
      this.requestUpdate();
    }
  }
}
