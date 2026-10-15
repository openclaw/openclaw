import type { AgentDeletionWorkerGuard } from "../state/agent-deletion-worker-contract.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type { PersistedClawMcpServerRef } from "./mcp-records.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";

export type ClawProvenanceWriteOperations = {
  "clawProvenance.packageStatus": {
    input: {
      ref: PersistedClawPackageRef;
      status: ClawPackageRefStatus;
      nowMs?: number;
      lease: OpenClawStateLeaseIdentity;
      deletion?: AgentDeletionWorkerGuard;
    };
    output: PersistedClawPackageRef;
  };
  "clawProvenance.reconcileMcp": {
    input: { agentId: string; digests: Record<string, string>; nowMs?: number };
    output: PersistedClawMcpServerRef[];
  };
};
