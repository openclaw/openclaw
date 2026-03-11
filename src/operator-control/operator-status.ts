import { getAcpRuntimeBackend } from "../acp/runtime/registry.js";
import { compileOperatorAgentRegistry } from "./agent-registry.js";
import { getOperatorDebSyncStatus } from "./deb-sync.js";
import { listOperatorMemory } from "./memory-store.js";
import { getOperatorTaskStatusSummary, getOperatorTaskStorePath } from "./task-store.js";
import { getOperatorAngelaStatus, getOperatorWorkerStatus } from "./worker-status.js";

export type OperatorControlStatusSnapshot = {
  primaryOperator: "tonya";
  fallbackOperator: "tony";
  authorityMode: "authoritative-failover";
  taskStorePath: string;
  registry: {
    agentCount: number;
    teamCount: number;
    sourcePath: string;
    sourceHash: string;
    generatedAt: number;
  };
  taskSummary: ReturnType<typeof getOperatorTaskStatusSummary>;
  runtimes: {
    acpBackendId: string | null;
    acpBackendHealthy: boolean;
    sharedMemoryAuthority: ReturnType<typeof listOperatorMemory>["authority"];
  };
  sharedMemory: {
    storePath: string;
    collections: ReturnType<typeof listOperatorMemory>["collections"];
  };
  worker: ReturnType<typeof getOperatorWorkerStatus>;
  mesh: {
    executionFleet: ReturnType<typeof getOperatorWorkerStatus>;
    projectOps: ReturnType<typeof getOperatorDebSyncStatus>;
    marketing: ReturnType<typeof getOperatorAngelaStatus>;
  };
};

export function getOperatorControlStatus(): OperatorControlStatusSnapshot {
  const registry = compileOperatorAgentRegistry();
  const acpBackend = getAcpRuntimeBackend();
  const sharedMemory = listOperatorMemory({ limit: 1 });
  const worker = getOperatorWorkerStatus();
  const debSync = getOperatorDebSyncStatus();
  const angela = getOperatorAngelaStatus();
  return {
    primaryOperator: "tonya",
    fallbackOperator: "tony",
    authorityMode: "authoritative-failover",
    taskStorePath: getOperatorTaskStorePath(),
    registry: {
      agentCount: registry.agentCount,
      teamCount: registry.teamCount,
      sourcePath: registry.sourcePath,
      sourceHash: registry.sourceHash,
      generatedAt: registry.generatedAt,
    },
    taskSummary: getOperatorTaskStatusSummary(),
    runtimes: {
      acpBackendId: acpBackend?.id ?? null,
      acpBackendHealthy: Boolean(acpBackend),
      sharedMemoryAuthority: sharedMemory.authority,
    },
    sharedMemory: {
      storePath: sharedMemory.storePath,
      collections: sharedMemory.collections,
    },
    worker,
    mesh: {
      executionFleet: worker,
      projectOps: debSync,
      marketing: angela,
    },
  };
}
