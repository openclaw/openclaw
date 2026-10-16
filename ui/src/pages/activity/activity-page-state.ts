import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { RouteLocation } from "@openclaw/uirouter";
import { onCleanup } from "solid-js";
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
import { projectSource } from "../../lib/reactive/projection.ts";
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
import { ACTIVITY_SUMMARY_ENSURE_METHOD, createSessionActivity } from "./session-activity-owner.ts";

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

export type ActivityPageState = ReturnType<typeof createActivityPageState>;

export function createActivityPageState(context: ApplicationContext) {
  let routeLocation: RouteLocation | undefined;
  let routeData: ActivityRouteData | undefined;
  let presentedRoute: { location: RouteLocation; data: ActivityRouteData } | undefined;
  let runInspector: RunInspectorState = { status: "empty" };
  let presencePayload: PresencePayload | undefined;
  let sessionActivityRevision = -1;
  let inspectorAbort: AbortController | null = null;
  let inspectorClient: GatewayBrowserClient | null = null;
  let inspectorEpoch = 0;
  let inspectorSelectorKey: string | null = null;
  let presenceClient: GatewayBrowserClient | null = null;
  let active = true;
  let publish = () => {};
  const sessionActivity = createSessionActivity(reconcileSessions);
  const liveActivity = createLiveActivity(context.gateway, context.sessions);
  const projection = projectSource(context, {
    read: () => ({
      context,
      routeLocation,
      routeData,
      presentedRoute,
      runInspector,
      presencePayload,
      sessionActivity,
      liveActivity,
      entries: liveActivity.snapshot.entries,
    }),
    subscribe: (_source, notify) => {
      publish = notify;
      return () => {
        publish = () => {};
      };
    },
    equality: "revision",
  });
  function setRouteLocation(location: RouteLocation | undefined) {
    routeLocation = location;
    routeData = location
      ? resolveActivityRouteData(
          location.search,
          activityPersonFromPath(location.pathname, context.basePath),
        )
      : undefined;
    if (location && routeData) {
      presentedRoute = { location, data: routeData };
    }
    syncSessionActivity();
    bindInspectorRoute();
    reconcileSessions();
  }

  function reconcileSessions() {
    if (!active) {
      return;
    }
    liveActivity.syncSessions(
      routeData?.mode === "live" ? (sessionActivity.result?.sessions ?? []) : [],
    );
    const canonical = routeLocation
      ? sessionActivity.canonicalLocation(
          routeLocation,
          context.basePath,
          projectPresencePayload(presencePayload).users,
        )
      : null;
    if (canonical) {
      context.replace("activity", canonical);
    }
    publish();
  }

  function applyGatewaySnapshot(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    sourceChanged: boolean,
  ) {
    if (sourceChanged || gateway.eventLogRevision !== sessionActivityRevision) {
      sessionActivityRevision = gateway.eventLogRevision;
      presentedRoute = undefined;
      void sessionActivity.load(null, null);
    }
    if (sourceChanged || snapshot.client !== presenceClient) {
      presenceClient = snapshot.client;
      const presence =
        snapshot.phase === "connected" ? readPresenceEntries(snapshot.hello?.snapshot) : undefined;
      presencePayload = presence ? { presence } : undefined;
    } else if (snapshot.phase !== "connected" && presencePayload) {
      presencePayload = undefined;
    }
    syncRunInspector(gateway, snapshot, sourceChanged);
    syncSessionActivity();
    reconcileSessions();
  }

  function syncSessionActivity(reason: "query" | "retry" = "query") {
    const snapshot = context.gateway.snapshot;
    void sessionActivity.load(
      snapshot.phase === "connected" ? snapshot.client : null,
      routeData?.mode === "sessions"
        ? routeData.filters
        : routeData?.mode === "live"
          ? "current"
          : null,
      reason,
      canCallGatewayMethod(snapshot, ACTIVITY_SUMMARY_ENSURE_METHOD, "operator.write", {
        requireAdvertisement: false,
      }),
    );
  }

  function bindInspectorRoute() {
    const route = routeData;
    const selector = route?.mode === "run" ? route.selector : null;
    const nextSelectorKey = inspectorRequestKey(route);
    if (nextSelectorKey === inspectorSelectorKey && route?.mode === "run") {
      return;
    }
    inspectorSelectorKey = nextSelectorKey;
    cancelInspectorRequest();
    inspectorClient = null;
    runInspector = selector ? { status: "loading", waitingForGateway: true } : { status: "empty" };
    if (route?.mode === "run") {
      syncRunInspector(context.gateway, context.gateway.snapshot, true);
    }
  }

  function cancelInspectorRequest() {
    inspectorEpoch += 1;
    inspectorAbort?.abort();
    inspectorAbort = null;
  }

  function syncRunInspector(
    gateway: ApplicationContext["gateway"],
    snapshot: ApplicationGatewaySnapshot,
    force = false,
  ) {
    const route = routeData;
    if (route?.mode !== "run") {
      return;
    }
    const selector = route.selector;
    if (!selector) {
      runInspector = { status: "empty" };
      publish();
      return;
    }
    inspectorSelectorKey = inspectorRequestKey(route);
    if (snapshot.phase !== "connected" || !snapshot.client) {
      cancelInspectorRequest();
      inspectorClient = null;
      runInspector = { status: "disconnected" };
      publish();
      return;
    }
    const unavailable =
      isGatewayMethodAdvertised(snapshot, "audit.run.inspect") === false
        ? "unsupported"
        : !canCallGatewayMethod(snapshot, "audit.run.inspect", "operator.read")
          ? "unauthorized"
          : null;
    if (unavailable) {
      cancelInspectorRequest();
      inspectorClient = snapshot.client;
      runInspector = { status: unavailable };
      publish();
      return;
    }
    if (
      !force &&
      inspectorClient === snapshot.client &&
      (runInspector.status === "loading" || runInspector.status === "ready")
    ) {
      return;
    }
    void loadRunInspector(gateway, snapshot.client, selector);
  }

  function isUnknownInspectMethod(error: unknown): boolean {
    return (
      error instanceof GatewayRequestError &&
      error.gatewayCode === "INVALID_REQUEST" &&
      (error.message === "unknown method: audit.run.inspect" ||
        error.message === "missing scope: operator.admin")
    );
  }

  async function loadRunInspector(
    gateway: ApplicationContext["gateway"],
    client: GatewayBrowserClient,
    selector: RunInspectorSelector,
    previousState?: Extract<RunInspectorState, { status: "ready" }>,
    pageKind: "executions" | "decisions" = "executions",
  ) {
    cancelInspectorRequest();
    const epoch = inspectorEpoch;
    const abort = new AbortController();
    inspectorAbort = abort;
    inspectorClient = client;
    const pageStatus = pageKind === "decisions" ? "decisionPageStatus" : "executionPageStatus";
    runInspector = previousState
      ? { ...previousState, [pageStatus]: "loading" }
      : { status: "loading", waitingForGateway: false };
    publish();
    const requestSelectorKey = inspectorRequestKey(routeData);
    const isCurrent = () =>
      inspectorEpoch === epoch &&
      context.gateway === gateway &&
      gateway.snapshot.client === client &&
      gateway.snapshot.phase === "connected" &&
      routeData?.mode === "run" &&
      inspectorRequestKey(routeData) === requestSelectorKey;
    const decisionCursor =
      pageKind === "decisions"
        ? previousState?.result.nextDecisionCursor
        : routeData?.mode === "run"
          ? routeData.decisionCursor
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
          runInspector = { ...previousState, decisionPageStatus: "error" };
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
      runInspector = { status: "ready", result, receiptPageCursors: cursors };
    } catch (error) {
      if (!isCurrent() || abort.signal.aborted) {
        return;
      }
      runInspector = isMissingOperatorReadScopeError(error)
        ? { status: "unauthorized" }
        : isUnknownInspectMethod(error)
          ? { status: "unsupported" }
          : previousState
            ? { ...previousState, [pageStatus]: "error" }
            : {
                status: "error",
                recovery:
                  decisionCursor && isExpiredDecisionCursorError(error) ? "restart" : "retry",
              };
    } finally {
      if (inspectorAbort === abort) {
        inspectorAbort = null;
        publish();
      }
    }
  }

  function loadMoreInspectorPage(kind: "executions" | "decisions") {
    const route = routeData;
    const gateway = context.gateway;
    const snapshot = gateway.snapshot;
    const inspectorState = runInspector;
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
      void loadRunInspector(gateway, snapshot.client, route.selector, inspectorState, kind);
    }
  }

  function restartRunInspector() {
    const route = routeData;
    if (route?.mode !== "run" || !route.selector) {
      return;
    }
    context.navigate("activity", { search: activityRunInspectorSearch(route.selector) });
  }

  function applyGatewayEvent(gateway: ApplicationContext["gateway"], event: GatewayEventFrame) {
    if (context.gateway !== gateway) {
      return;
    }
    const change =
      event.event === "session.message" ? readSessionChangedEvent(event.payload) : null;
    const terminalMessage =
      change &&
      (change.hasActiveRun === false ||
        (change.status !== null && change.status !== "running" && change.status !== "queued"));
    if (event.event === "sessions.changed" || (routeData?.mode === "live" && terminalMessage)) {
      sessionActivity.invalidate(event.payload);
    }
    if (event.event === "presence") {
      const presence = readPresenceEntries(event.payload);
      presencePayload = presence ? { presence } : undefined;
      reconcileSessions();
    }
  }

  const stopActivity = liveActivity.subscribe(() => publish());
  const stopAgents = context.agents.subscribe(() => publish());
  const gateway = context.gateway;
  applyGatewaySnapshot(gateway, gateway.snapshot, true);
  const stopEvents = gateway.subscribeEvents((event) => applyGatewayEvent(gateway, event));
  const stopGateway = gateway.subscribe((snapshot) =>
    applyGatewaySnapshot(gateway, snapshot, false),
  );
  onCleanup(() => {
    active = false;
    stopActivity();
    liveActivity.dispose();
    stopAgents();
    stopGateway();
    stopEvents();
    cancelInspectorRequest();
    sessionActivity.dispose();
  });
  return {
    read: projection.read,
    revision: projection.revision,
    setRouteLocation,
    syncSessionActivity,
    syncRunInspector,
    loadMoreInspectorPage,
    restartRunInspector,
  };
}
