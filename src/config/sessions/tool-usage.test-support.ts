import {
  flushAgentToolUsage,
  readAgentToolUsageStatus,
  type AgentToolUsageOptions,
} from "./tool-usage.js";

export async function seedAgentToolUsageRunForTest(
  input: AgentToolUsageOptions & { runId?: string },
) {
  const now = input.now ?? Date.now();
  const { generation } = await readAgentToolUsageStatus({ ...input, now });
  const applied = await flushAgentToolUsage({
    ...input,
    generation,
    startedAt: now,
    now,
    rows: [],
  });
  if (!applied) {
    throw new Error("Tool usage fixture lost its generation");
  }
  return { generation };
}
