import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { projectedAgentRunInputKey } from "../infra/agent-run-projection.js";
import type { AgentRunContext } from "../infra/agent-run-registry.types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logError } from "../logger.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { SessionEventSubscriberRegistry } from "./server-chat-state.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";
import { withPreparedSessionEventRow } from "./session-event-prepared-row.js";
import type { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { formatForLog } from "./ws-log.js";

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
    const publish = () => {
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
          ...deps.buildSnapshot(sessionKey, event, agentId, phase),
        },
        sessionEventConnIds,
        { dropIfSlow: true },
      );
      // Failed preparation/publication must leave the next observation publishable.
      if (runContext && modelInput) {
        publishedModelInputs.set(runContext, modelInput);
      }
    };
    void withPreparedSessionEventRow(
      deps.getSessionRowProjection?.(),
      sessionKey,
      agentId,
      publish,
    ).catch((error: unknown) =>
      logError(`gateway: session snapshot publication failed: ${formatErrorMessage(error)}`),
    );
  };
}
