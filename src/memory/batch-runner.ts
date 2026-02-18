import { splitBatchRequests } from "./batch-utils.js";
import { runWithConcurrency } from "./internal.js";

export async function runEmbeddingBatchGroups<TRequest>(params: {
  requests: TRequest[];
  maxRequests: number;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debugLabel: string;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  runGroup: (args: {
    group: TRequest[];
    groupIndex: number;
    groups: number;
    byCustomId: Map<string, number[]>;
  }) => Promise<void>;
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) {
    return new Map();
  }
  const groups = splitBatchRequests(params.requests, params.maxRequests);
  const byCustomId = new Map<string, number[]>();
  const tasks = groups.map((group, groupIndex) => async () => {
    await params.runGroup({ group, groupIndex, groups: groups.length, byCustomId });
  });

  params.debug?.(params.debugLabel, {
    requests: params.requests.length,
    groups: groups.length,
    wait: params.wait,
    concurrency: params.concurrency,
    pollIntervalMs: params.pollIntervalMs,
    timeoutMs: params.timeoutMs,
  });

  await runWithConcurrency(tasks, params.concurrency);
  return byCustomId;
}
