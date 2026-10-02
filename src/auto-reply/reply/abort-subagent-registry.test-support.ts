import { persistSubagentRunsToDiskOrThrow } from "../../agents/subagents/registry/subagent-registry-state.js";
import { registerSubagentRun } from "../../agents/subagents/registry/subagent-registry.js";
import { getSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";

export type SubagentRunFixture = Parameters<typeof registerSubagentRun>[0] & {
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
  pauseReason?: SubagentRunRecord["pauseReason"];
};

export async function addSubagentFixture({
  createdAt,
  startedAt,
  endedAt,
  outcome,
  pauseReason,
  ...run
}: SubagentRunFixture) {
  await registerSubagentRun({ requesterAgentId: "main", ...run });
  const entry = getSubagentRunByChildSessionKey(run.childSessionKey);
  if (!entry || entry.runId !== run.runId) {
    throw new Error(`Subagent fixture registration did not publish ${run.runId}`);
  }
  entry.createdAt = createdAt;
  entry.execution = {
    ...entry.execution,
    status: endedAt === undefined ? "running" : "terminal",
    startedAt,
    endedAt,
    outcome,
  };
  entry.pauseReason = pauseReason;
  persistSubagentRunsToDiskOrThrow(new Map([[run.runId, entry]]), [run.runId]);
}
