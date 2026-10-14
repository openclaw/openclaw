import type { AgentEventPayload, AgentEventRuntimePayload } from "../infra/agent-events.js";
import { projectedAgentRunInputKey } from "../infra/agent-run-projection.js";
import type { AgentRunContext } from "../infra/agent-run-registry.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logError } from "../logger.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
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

function createSessionEventSnapshotBuilder({
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

type SessionLifecyclePublication = {
  event: AgentEventRuntimePayload;
  sessionKey: string;
  agentId: string | undefined;
  clientRunId: string;
} & (
  | { phase: "start" | "model"; runContext: AgentRunContext | undefined }
  | {
      phase: "end" | "error";
      persistence: Promise<void>;
      projection: SessionRowProjection | undefined;
      publishLifecycle?: boolean;
    }
);

export function createSessionLifecyclePublisher(
  deps: SessionEventSnapshotDependencies & {
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
    sessionEventSubscribers: SessionEventSubscriberRegistry;
    getSessionRowProjection?: () => SessionRowProjection | undefined;
    persistGatewaySessionLifecycleEventForEvent: typeof persistGatewaySessionLifecycleEvent;
  },
) {
  const buildSnapshot = createSessionEventSnapshotBuilder(deps);
  const publishedModelInputs = new WeakMap<AgentRunContext, string>();
  const publish = (params: SessionLifecyclePublication) => {
    const { event, phase, sessionKey, agentId, clientRunId } = params;
    const broadcastSnapshot = (
      snapshotEvent: AgentEventPayload | undefined,
      sessionEventConnIds: ReadonlySet<string>,
      projection: SessionRowProjection | undefined,
      read?: SessionRowReadView,
    ) =>
      deps.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          phase,
          runId: event.runId,
          ...(clientRunId !== event.runId ? { clientRunId } : {}),
          ts: event.ts,
          ...buildSnapshot(
            sessionKey,
            snapshotEvent,
            agentId,
            true,
            phase !== "model",
            event,
            read,
          ),
        },
        sessionEventConnIds,
        {
          dropIfSlow: true,
          ...(read && projection
            ? { prepareSessionProjection: prepareSessionEventProjection(projection, read) }
            : {}),
        },
      );
    switch (params.phase) {
      case "end":
      case "error": {
        const { persistence, projection } = params;
        const broadcastSessionChange = (snapshotEvent?: AgentEventPayload) =>
          withPreparedSessionEventRow(projection, sessionKey, agentId, (read) => {
            if (params.publishLifecycle === false || parseCronRunScopeSuffix(sessionKey).runId) {
              return;
            }
            const sessionEventConnIds = deps.sessionEventSubscribers.getAll();
            if (hasSessionChangeReceivers(sessionEventConnIds)) {
              broadcastSnapshot(snapshotEvent, sessionEventConnIds, projection, read);
            }
          });
        // Terminal writes serialize with restart markers. Reload only after the
        // write so subscribers see the canonical post-race session state.
        void persistence
          .then(
            async () => {
              await broadcastSessionChange();
            },
            async (err: unknown) => {
              logError(
                `gateway: terminal session persistence failed session=${formatForLog(sessionKey)} run=${formatForLog(event.runId)} error=${formatForLog(err)}`,
              );
              await broadcastSessionChange(event);
            },
          )
          .catch((error: unknown) => {
            logError(
              `gateway: terminal session snapshot publication failed: ${formatErrorMessage(error)}`,
            );
          });
        return;
      }
      case "start":
      case "model": {
        const { runContext } = params;
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
        const publishPrepared = (read?: SessionRowReadView) => {
          const modelInput = readModelInput();
          if (runContext && modelInput && publishedModelInputs.get(runContext) === modelInput) {
            return;
          }
          broadcastSnapshot(event, sessionEventConnIds, projection, read);
          // Failed preparation/publication must leave the next observation publishable.
          if (runContext && modelInput) {
            publishedModelInputs.set(runContext, modelInput);
          }
        };
        void withPreparedSessionEventRow(projection, sessionKey, agentId, publishPrepared).catch(
          (error: unknown) =>
            logError(`gateway: session snapshot publication failed: ${formatErrorMessage(error)}`),
        );
      }
    }
  };
  return { buildSnapshot, publish };
}
