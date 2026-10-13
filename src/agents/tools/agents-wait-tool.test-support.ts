import type { PreparedSubagentRunsRead } from "../subagents/registry/subagent-registry-read-snapshot.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { createAgentsWaitTool, waitForCollectorCompletion } from "./agents-wait-tool.js";

export function createMainSessionWaitTool() {
  return createAgentsWaitTool({
    agentSessionKey: "agent:main:main",
    agentId: "main",
    config: { tools: { swarm: true } },
  });
}

export function waitAtBoundary(boundary: "tool" | "bridge", runId: string, signal?: AbortSignal) {
  return boundary === "tool"
    ? createMainSessionWaitTool()
        .execute("wait", { ids: [runId], timeoutSeconds: 1 }, signal)
        .then((result) => result.details)
    : waitForCollectorCompletion({
        runId,
        currentSessionKeys: new Set(["agent:main:main"]),
        currentAgentId: "main",
        signal,
      });
}

export function selectRuns(
  records: ReadonlyMap<string, SubagentRunRecord>,
  runIds: readonly string[],
): Map<string, SubagentRunRecord> {
  return new Map(
    runIds.flatMap((runId) => {
      const entry =
        records.get(runId) ??
        [...records.values()].find((candidate) => candidate.swarmRunId === runId);
      return entry ? [[runId, entry] as const] : [];
    }),
  );
}

export function preparedRuns(
  read: () => ReadonlyMap<string, SubagentRunRecord>,
): PreparedSubagentRunsRead {
  return {
    consume: (consume) => ({ ready: true, value: consume(read()) }),
  };
}

export function collectorRun(
  runId: string,
  requesterSessionKey: string,
  completion?: SubagentRunRecord["collectorCompletion"],
): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:worker:subagent:${runId}`,
    controllerSessionKey: requesterSessionKey,
    requesterSessionKey,
    requesterDisplayKey: requesterSessionKey,
    task: runId,
    cleanup: "keep",
    createdAt: Date.now(),
    execution: { status: completion ? "terminal" : "running" },
    collect: true,
    swarmRequesterSessionKey: requesterSessionKey,
    groupId: "group",
    completion: { required: false, resultText: completion ? `result-${runId}` : undefined },
    collectorCompletion: completion,
  };
}
