import type { AgentWaitParams } from "../../../packages/gateway-protocol/src/index.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { resolveAgentWaitSource } from "./agent-dedupe.js";
import {
  captureAgentJobSession,
  getAgentJobSession,
  projectAgentJobObservation,
  waitForAgentJob,
} from "./agent-job.js";

export function prepareAgentWaitForTurn(
  context: Pick<GatewayRequestContext, "chatAbortControllers" | "chatQueuedTurns" | "dedupe">,
  params: AgentWaitParams,
) {
  const runId = params.runId.trim();
  const timeoutMs = params.timeoutMs ?? 30_000;
  const source = resolveAgentWaitSource(context, runId);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const queuedResult = () => {
    const queued = context.chatQueuedTurns.get(runId);
    return queued
      ? {
          session: captureAgentJobSession({ ...queued, lifecycleGeneration }),
          result: {
            runId,
            status: "pending" as const,
            timeoutPhase: "queue" as const,
            providerStarted: false,
          },
        }
      : undefined;
  };
  const queuedBeforeWait = queuedResult();
  // Compaction updates this registration; a reused run ID must not replace it.
  const runContext = getAgentRunContext(runId);
  const initialSession =
    queuedBeforeWait?.session ??
    getAgentJobSession(runId, source === "chat" ? "chat" : undefined) ??
    captureAgentJobSession(runContext);
  const wait = async () => {
    if (queuedBeforeWait) {
      return queuedBeforeWait;
    }
    const snapshot = await waitForAgentJob({ runId, timeoutMs, source });
    const queuedAfterWait = queuedResult();
    if (queuedAfterWait) {
      return queuedAfterWait;
    }
    if (!snapshot) {
      return {
        result: { runId, status: "timeout" as const },
        session: captureAgentJobSession(runContext) ?? initialSession,
      };
    }
    const { session, ...result } = projectAgentJobObservation(snapshot);
    return { session, result: { runId, ...result } };
  };
  return { session: initialSession, wait };
}
