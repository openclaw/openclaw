import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
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
  await mutateSubagentRuns([run.runId], (rows) => {
    const current = rows.get(run.runId);
    if (!current || current.childSessionKey !== run.childSessionKey) {
      throw new Error(`Subagent fixture registration was replaced ${run.runId}`);
    }
    return {
      value: undefined,
      postimages: new Map([
        [
          run.runId,
          {
            ...current,
            createdAt,
            execution: {
              ...current.execution,
              status: endedAt === undefined ? ("running" as const) : ("terminal" as const),
              startedAt,
              endedAt,
              outcome,
            },
            pauseReason,
          },
        ],
      ]),
    };
  });
}
