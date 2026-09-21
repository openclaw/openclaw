import { assessPopulation, buildPopulationSnapshot } from "./population-controller.js";
import type { PopulationDecision } from "./population-types.js";

export type HostCollectorTerminalStatus = "done" | "failed" | "killed" | "timeout" | null;

export type HostCollectorDynamicsRecord = {
  runId: string;
  terminalStatus: HostCollectorTerminalStatus;
};

function requireNonEmptyText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} must be non-empty`);
  }
  return normalized;
}

function terminalDebt(status: HostCollectorTerminalStatus): number | null {
  if (status === null) {
    return null;
  }
  return status === "done" ? 0 : 1;
}

function terminalProgress(status: HostCollectorTerminalStatus): number | null {
  if (status === null) {
    return null;
  }
  return status === "done" ? 1 : 0;
}

/**
 * Build an advisory population assessment from facts owned by the host runtime.
 * Semantic candidate signals remain unknown until a trusted producer measures them.
 */
export function assessHostCollectorPopulation(params: {
  groupId: string;
  maxConcurrent: number;
  records: readonly HostCollectorDynamicsRecord[];
}): PopulationDecision {
  const groupId = requireNonEmptyText(params.groupId, "group id");
  if (!Number.isSafeInteger(params.maxConcurrent) || params.maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive safe integer");
  }
  const runIds = new Set<string>();
  const records = params.records.map((record) => {
    const runId = requireNonEmptyText(record.runId, "collector run id");
    if (runIds.has(runId)) {
      throw new Error("collector dynamics records require unique run ids");
    }
    runIds.add(runId);
    return { runId, terminalStatus: record.terminalStatus };
  });
  const activeCount = records.filter((record) => record.terminalStatus === null).length;
  const resourcePressure = Math.min(1, activeCount / params.maxConcurrent);
  const observations = records.map((record) => ({
    replicaId: record.runId,
    candidateEntropy: null,
    coherence: null,
    mobility: null,
    evidenceCompleteness: null,
    verifierDisagreement: null,
    resourcePressure,
    contextPressure: null,
    debtPressure: terminalDebt(record.terminalStatus),
    branchingRatio: null,
    progressRate: terminalProgress(record.terminalStatus),
  }));

  return assessPopulation(
    buildPopulationSnapshot({
      campaignId: groupId,
      groupId,
      replicas: [],
      observations,
      meanCorrelation: null,
    }),
  );
}
