import type { SessionRunCompletedEvent } from "../../packages/gateway-protocol/src/schema/sessions-run-completed.js";
import { isAgentLifecycleYieldedWaiting } from "../agents/agent-lifecycle-parent-state.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  classifyAgentRunTerminalOutcome,
  hasExecutionSettlement,
} from "../agents/agent-run-terminal-outcome.js";
import { countActiveDescendantRuns } from "../agents/subagents/registry/subagent-registry-read.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";

/** The session lifecycle subscriber owns this live-only projection and retires it on shutdown. */
export function createSessionTerminalPublisher(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  resolveActiveLifecycleGenerationForRun: (runId: string) => string | undefined;
}) {
  let disposed = false;
  const announcedRuns = new Set<string>();
  return {
    dispose() {
      disposed = true;
      announcedRuns.clear();
    },
    publish(input: {
      event: AgentEventRuntimePayload;
      sessionKey: string;
      agentId?: string;
      runId: string;
      snapshot: Record<string, unknown>;
      recipients: ReadonlySet<string>;
      sessionKeys: string[];
      completionEligible: boolean;
    }) {
      const { event, sessionKey, agentId, runId, snapshot, recipients } = input;
      if (
        disposed ||
        parseCronRunScopeSuffix(sessionKey).runId ||
        !hasSessionChangeReceivers(recipients)
      ) {
        return;
      }
      params.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey,
          ...(agentId ? { agentId } : {}),
          phase: event.data.phase,
          runId: event.runId,
          ...(runId !== event.runId ? { clientRunId: runId } : {}),
          ts: event.ts,
          ...snapshot,
        },
        recipients,
        { dropIfSlow: true },
      );
      const generation = params.resolveActiveLifecycleGenerationForRun(event.runId);
      if (
        !input.completionEligible ||
        (event.sessionId && event.sessionId !== snapshot.sessionId) ||
        (event.lifecycleGeneration && generation && event.lifecycleGeneration !== generation)
      ) {
        return;
      }
      const completion = projectSessionRunCompletion(input);
      if (completion && countActiveDescendantRuns(sessionKey, completion.agentId) > 0) {
        return;
      }
      const key = JSON.stringify([completion?.agentId, sessionKey, event.runId]);
      if (!completion || announcedRuns.has(key)) {
        return;
      }
      announcedRuns.add(key);
      if (announcedRuns.size > 5_000) {
        const oldest = announcedRuns.values().next().value;
        if (oldest !== undefined) {
          announcedRuns.delete(oldest);
        }
      }
      params.broadcastToConnIds("session.run.completed", completion, recipients, {
        sessionKeys: input.sessionKeys,
        agentId: completion.agentId,
      });
    },
  };
}

/** Project the execution owner's settled fact, never observer health or a delivered message. */
function projectSessionRunCompletion(params: {
  event: AgentEventRuntimePayload;
  sessionKey: string;
  agentId?: string;
  runId: string;
}): SessionRunCompletedEvent | undefined {
  const { event, sessionKey, runId } = params;
  const agentId = params.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  const phase = event.data.phase;
  if (
    !agentId?.trim() ||
    !hasExecutionSettlement(event.data) ||
    (phase !== "end" && phase !== "error") ||
    isAgentLifecycleYieldedWaiting(event.data)
  ) {
    return undefined;
  }
  const outcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
    phase,
    data: event.data,
    endedAt: event.data.endedAt ?? event.ts,
  });
  const classification = classifyAgentRunTerminalOutcome(outcome);
  return {
    sessionKey,
    agentId,
    runId,
    status:
      classification === "success"
        ? "ok"
        : classification === "timeout"
          ? "timeout"
          : classification === "cancellation"
            ? "aborted"
            : "error",
  };
}
