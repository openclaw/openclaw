import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { getAgentRunContext, getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";

export type TaskAgentEventSource = {
  runId: string;
  lifecycleGeneration: string;
  runContext: ReturnType<typeof getAgentRunContext>;
  subagent: ReturnType<typeof subagentRuns.get>;
  subagentGeneration: number | undefined;
};

export function captureTaskAgentEventSource(event: AgentEventPayload): TaskAgentEventSource {
  const runId = event.runId;
  const subagent = subagentRuns.get(runId);
  return {
    runId,
    lifecycleGeneration: event.lifecycleGeneration ?? getAgentRunLifecycleGeneration(),
    runContext: getAgentRunContext(runId),
    subagent,
    subagentGeneration: subagent?.generation,
  };
}

export function sameTaskAgentEventSource(
  left: TaskAgentEventSource,
  right: TaskAgentEventSource,
): boolean {
  return (
    left.runId === right.runId &&
    left.lifecycleGeneration === right.lifecycleGeneration &&
    left.runContext === right.runContext &&
    left.subagent === right.subagent &&
    left.subagentGeneration === right.subagentGeneration
  );
}
