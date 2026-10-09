import type { AgentEventPayload, AgentEventRuntimePayload } from "../infra/agent-events.js";
import { projectedAgentRunInputKey } from "../infra/agent-run-projection.js";
import type { AgentRunContext } from "../infra/agent-run-registry.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logError } from "../logger.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { SessionEventSubscriberRegistry } from "./server-chat-state.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { withPreparedSessionEventRow } from "./session-event-prepared-row.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import type { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import type { SessionRowReadView } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { GatewaySessionRow } from "./session-utils.js";
import { formatForLog } from "./ws-log.js";

export type SessionEventSnapshotDependencies = {
  loadGatewaySessionLifecycleSnapshotForEvent: (
    key: string,
    options?: {
      agentId?: string;
      ownerEvent?: AgentEventPayload;
      sessionRows?: SessionRowReadView;
    },
  ) => { row: GatewaySessionRow | null; lifecycleRunId?: string };
  resolveSessionActiveRunState?: (params: {
    requestedKey: string;
    canonicalKey: string;
    sessionId?: string;
    agentId?: string;
  }) => { active: boolean; runIds?: string[] };
};

export function createSessionEventSnapshotBuilder({
  loadGatewaySessionLifecycleSnapshotForEvent,
  resolveSessionActiveRunState,
}: SessionEventSnapshotDependencies) {
  return (
    sessionKey: string,
    evt?: AgentEventPayload,
    agentId?: string,
    includeActiveRunState = false,
    lifecycleProjection = false,
    ownerEvent = evt,
    read?: SessionRowReadView,
  ) => {
    const snapshotOptions =
      agentId || ownerEvent || read
        ? {
            ...(agentId ? { agentId } : {}),
            ...(ownerEvent ? { ownerEvent } : {}),
            ...(read ? { sessionRows: read } : {}),
          }
        : undefined;
    const lifecycleSnapshot = loadGatewaySessionLifecycleSnapshotForEvent(
      sessionKey,
      snapshotOptions,
    );
    const { lifecycleRunId, row } = lifecycleSnapshot;
    const activeRunState = includeActiveRunState
      ? resolveSessionActiveRunState?.({
          requestedKey: sessionKey,
          canonicalKey: row?.key ?? sessionKey,
          ...(row?.sessionId ? { sessionId: row.sessionId } : {}),
          ...(agentId ? { agentId } : {}),
        })
      : undefined;
    return buildGatewaySessionSnapshot({
      sessionRow: row,
      agentId,
      includeSession: true,
      lifecycle: lifecycleProjection,
      event: evt,
      lifecycleRunId,
      activeRunState,
    });
  };
}

type LiveLifecyclePhase = "start" | "model";

export function createSessionLifecyclePublisher(deps: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
  persistGatewaySessionLifecycleEventForEvent: typeof persistGatewaySessionLifecycleEvent;
  buildSnapshot: (
    sessionKey: string,
    event: AgentEventRuntimePayload,
    agentId: string | undefined,
    phase: LiveLifecyclePhase,
    read?: SessionRowReadView,
  ) => Record<string, unknown>;
}) {
  const publishedModelInputs = new WeakMap<AgentRunContext, string>();
  return ({
    event,
    phase,
    sessionKey,
    agentId,
    clientRunId,
    runContext,
  }: {
    event: AgentEventRuntimePayload;
    phase: LiveLifecyclePhase;
    sessionKey: string;
    agentId: string | undefined;
    clientRunId: string;
    runContext: AgentRunContext | undefined;
  }) => {
    if (phase === "start") {
      void deps
        .persistGatewaySessionLifecycleEventForEvent({
          sessionKey,
          agentId,
          event: {
            ...event,
            ...(clientRunId !== event.runId ? { clientRunId } : {}),
          },
        })
        .catch((err: unknown) => {
          logError(
            `gateway: start session persistence failed session=${formatForLog(sessionKey)} run=${formatForLog(event.runId)} error=${formatForLog(err)}`,
          );
        });
    }
    const sessionEventConnIds = deps.sessionEventSubscribers.getAll();
    if (!hasSessionChangeReceivers(sessionEventConnIds)) {
      return;
    }
    const readModelInput = () =>
      phase === "model" && runContext
        ? JSON.stringify([sessionKey, agentId, projectedAgentRunInputKey(runContext)])
        : undefined;
    const observedModelInput = readModelInput();
    if (
      runContext &&
      observedModelInput &&
      publishedModelInputs.get(runContext) === observedModelInput
    ) {
      return;
    }
    const projection = deps.getSessionRowProjection?.();
    const publish = (read?: SessionRowReadView) => {
      const modelInput = readModelInput();
      if (runContext && modelInput && publishedModelInputs.get(runContext) === modelInput) {
        return;
      }
      deps.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          phase,
          runId: event.runId,
          ...(clientRunId !== event.runId ? { clientRunId } : {}),
          ts: event.ts,
          ...deps.buildSnapshot(sessionKey, event, agentId, phase, read),
        },
        sessionEventConnIds,
        {
          dropIfSlow: true,
          ...(read && projection
            ? { prepareSessionProjection: prepareSessionEventProjection(projection, read) }
            : {}),
        },
      );
      // Failed preparation/publication must leave the next observation publishable.
      if (runContext && modelInput) {
        publishedModelInputs.set(runContext, modelInput);
      }
    };
    void withPreparedSessionEventRow(projection, sessionKey, agentId, publish).catch(
      (error: unknown) =>
        logError(`gateway: session snapshot publication failed: ${formatErrorMessage(error)}`),
    );
  };
}
