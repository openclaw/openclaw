/** Cumulative output-token usage for one active agent run. */
export type AgentRunUsage = {
  outputTokens: number;
};

type RecordAgentRunOutputTokensParams = {
  runId: string;
  lifecycleGeneration?: string;
  outputTokens: number;
  emit: (usage: AgentRunUsage) => void;
};

const usageByRun = new Map<string, Map<string, AgentRunUsage>>();

/** Adds one completed model call and commits the new total only when delivery succeeds. */
export function recordAgentRunOutputTokens(
  params: RecordAgentRunOutputTokensParams,
): AgentRunUsage | undefined {
  const outputTokens = Math.floor(params.outputTokens);
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) {
    return undefined;
  }
  const lifecycleGeneration = params.lifecycleGeneration ?? "";
  const usageByGeneration = usageByRun.get(params.runId) ?? new Map<string, AgentRunUsage>();
  const previous = usageByGeneration.get(lifecycleGeneration);
  const usage = {
    outputTokens: (previous?.outputTokens ?? 0) + outputTokens,
  };
  params.emit(usage);
  usageByGeneration.set(lifecycleGeneration, usage);
  usageByRun.set(params.runId, usageByGeneration);
  return usage;
}

export function clearAgentRunUsage(runId: string): void {
  usageByRun.delete(runId);
}

export function resetAgentRunUsageForTest(): void {
  usageByRun.clear();
}
