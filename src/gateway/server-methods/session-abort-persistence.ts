import type { ActiveEmbeddedRunOwner } from "../../agents/embedded-agent-runner/runs.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { persistGatewaySessionLifecycleEvent } from "../session-lifecycle-state.js";

/** Capture the session writer and lifecycle generation before cancellation can yield. */
export function createSessionAbortPersistence(params: {
  sessionKey: string;
  agentId?: string;
  lifecycleRevision?: string;
  startedAt?: number;
  lifecycleGeneration: string;
  stopReason?: string;
  assertCurrent?: () => void;
}) {
  return (owner: Pick<ActiveEmbeddedRunOwner, "runId" | "sessionId" | "startedAtMs">) =>
    persistGatewaySessionLifecycleEvent({
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      assertCommitAllowed: () => {
        params.assertCurrent?.();
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      },
      expectedWriter: {
        runId: owner.runId,
        sessionId: owner.sessionId,
        lifecycleRevision: params.lifecycleRevision,
      },
      event: {
        runId: owner.runId,
        sessionId: owner.sessionId,
        lifecycleGeneration: params.lifecycleGeneration,
        ts: Date.now(),
        data: {
          phase: "end",
          status: "cancelled",
          aborted: true,
          stopReason: params.stopReason ?? "rpc",
          startedAt: owner.startedAtMs ?? params.startedAt,
          endedAt: Date.now(),
        },
      },
    });
}
