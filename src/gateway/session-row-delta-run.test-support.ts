import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { loadGatewaySessionEntryReadOnlyAsync } from "./session-utils-store.js";

/** Provider-free execution fixture, retaining real run/lineage projection owners. */
export async function startSessionRowDeltaSubagents(keys: readonly string[]) {
  const runIds: string[] = [];
  for (const [depth, childSessionKey] of keys.entries()) {
    if (depth === 0 || depth === keys.length - 1) {
      continue;
    }
    const child = await loadGatewaySessionEntryReadOnlyAsync(childSessionKey, { agentId: "main" });
    const requesterSessionKey = keys[depth - 1];
    if (!child.entry || !requesterSessionKey) {
      throw new Error("Expected durable nested session and its parent");
    }
    const runId = `row-delta-subagent-${depth}`;
    const startedAt = Date.now() - 10_000;
    registerAgentRunContext(runId, {
      sessionKey: childSessionKey,
      sessionId: child.entry.sessionId,
      agentId: "main",
      projectSessionActive: true,
    });
    subagentRuns.set(runId, {
      runId,
      childSessionKey,
      requesterSessionKey,
      requesterAgentId: "main",
      requesterDisplayKey: requesterSessionKey,
      controllerSessionKey: requesterSessionKey,
      task: "Synthetic nested tool execution",
      cleanup: "keep",
      createdAt: startedAt,
      execution: { status: "running", startedAt },
      completion: { required: false },
      delivery: { status: "not_required" },
    });
    runIds.push(runId);
  }
  return () => {
    for (const runId of runIds) {
      clearAgentRunContext(runId);
      subagentRuns.delete(runId);
    }
  };
}
