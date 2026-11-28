/** Cumulative output-token usage for one active agent run. */
type AgentRunUsage = {
  outputTokens: number;
  usageReport?: { state: "available" | "unavailable" };
};

const usageByRun = new Map<string, Map<string, AgentRunUsage>>();

/** Adds one completed model call and emits the new generation-scoped total. */
export function recordAgentRunOutputTokens(params: {
  runId: string;
  lifecycleGeneration: string;
  outputTokens: number;
  usageReport?: AgentRunUsage["usageReport"];
  emit: (usage: AgentRunUsage) => boolean;
}): AgentRunUsage | undefined {
  const outputTokens = Math.floor(params.outputTokens);
  if (
    !Number.isFinite(outputTokens) ||
    outputTokens < 0 ||
    (outputTokens === 0 && !params.usageReport)
  ) {
    return undefined;
  }
  const usageByGeneration = usageByRun.get(params.runId) ?? new Map<string, AgentRunUsage>();
  const previous = usageByGeneration.get(params.lifecycleGeneration);
  const usage: AgentRunUsage = {
    outputTokens:
      (previous?.outputTokens ?? 0) +
      (params.usageReport?.state === "unavailable" ? 0 : outputTokens),
    ...(previous?.usageReport?.state === "unavailable" ||
    params.usageReport?.state === "unavailable"
      ? { usageReport: { state: "unavailable" } as const }
      : {}),
  };
  if (!params.emit(usage)) {
    return undefined;
  }
  usageByGeneration.set(params.lifecycleGeneration, usage);
  usageByRun.set(params.runId, usageByGeneration);
  return usage;
}

export function clearAgentRunUsage(runId: string, lifecycleGeneration?: string): void {
  if (lifecycleGeneration === undefined) {
    usageByRun.delete(runId);
    return;
  }
  const usageByGeneration = usageByRun.get(runId);
  usageByGeneration?.delete(lifecycleGeneration);
  if (usageByGeneration?.size === 0) {
    usageByRun.delete(runId);
  }
}

export function resetAgentRunUsageForTest(): void {
  usageByRun.clear();
}
