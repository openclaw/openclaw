import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../../agents/subagents/registry/subagent-registry-publication.js";
import { seedSubagentRunForReadTest } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";

export type TypingBackgroundChildState = "running" | "waiting" | "unknown";

export function createTypingBackgroundChild(params: {
  runId: string;
  requesterRunId: string;
  requesterSessionKey: string;
  childSessionKey: string;
  initialState?: TypingBackgroundChildState;
  waitKind?: "approval" | "user_input" | "agent_messages" | "external";
}) {
  const sessionId = params.childSessionKey + "-session";
  const now = Date.now();
  seedSubagentRunForReadTest({
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    childAgentId: "main",
    requesterSessionKey: params.requesterSessionKey,
    requesterAgentId: "main",
    requesterTurnRunId: params.requesterRunId,
    requesterTurnYielded: true,
    expectsCompletionMessage: true,
    generation: 1,
    createdAt: now,
    execution: { status: "running", startedAt: now },
  });
  const claimId = claimAgentRunContext(
    params.runId,
    { sessionKey: params.childSessionKey, sessionId, agentId: "main" },
    { trackOwner: true, ownsContext: true, protectFromSweep: true },
  );
  if (!claimId) {
    throw new Error(`Could not claim test child owner ${params.runId}`);
  }
  const emitExecution = (state: TypingBackgroundChildState) => {
    emitAgentEvent({
      runId: params.runId,
      sessionKey: params.childSessionKey,
      sessionId,
      stream: "execution",
      data: {
        state,
        sourceId: "typing-background-test",
        executionId: "typing-background-test-execution",
        ...(state === "waiting" ? { wait: { kind: params.waitKind ?? "user_input" } } : {}),
      },
    });
  };
  publishSubagentRunChanges([params.childSessionKey], [params.runId]);
  emitExecution(params.initialState ?? "running");
  let closed = false;
  return {
    setState: emitExecution,
    finish() {
      emitAgentEvent({
        runId: params.runId,
        sessionKey: params.childSessionKey,
        sessionId,
        stream: "lifecycle",
        data: { phase: "end" },
      });
    },
    cleanup() {
      if (closed) {
        return;
      }
      closed = true;
      releaseAgentRunContext(params.runId, claimId);
      subagentRuns.delete(params.runId);
      publishSubagentRunChanges([params.childSessionKey], [params.runId]);
    },
  };
}
