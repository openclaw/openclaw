import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type { PersistedClawMcpServerRef } from "./mcp-records.js";
import type { ClawMonitorCleanupSnapshot } from "./monitor-cleanup.read.types.js";
import type {
  ClawPackageRefStatus,
  PersistedClawPackageRef,
} from "./package-extension-provenance.js";
import type { PortableHeartbeatMutation } from "./portable-heartbeat-write.types.js";
import type { ClawRemovalJournalWorkerInput } from "./removal-journal-contract.js";

export type ClawProvenanceWriteOperations = {
  "clawProvenance.removalJournal": {
    input: ClawRemovalJournalWorkerInput;
    output: { nonce: string };
  };
  "clawProvenance.portableHeartbeat": {
    input: PortableHeartbeatMutation & { nonce: string };
    output: { nonce: string };
  };
  "clawProvenance.monitorCleanupGuard": {
    input: { agentId: string; storePath: string; expected: ClawMonitorCleanupSnapshot };
    output: void;
  };
  "clawProvenance.packageStatus": {
    input: {
      ref: PersistedClawPackageRef;
      status: ClawPackageRefStatus;
      nowMs?: number;
      lease: OpenClawStateLeaseIdentity;
    };
    output: PersistedClawPackageRef;
  };
  "clawProvenance.reconcileMcp": {
    input: { agentId: string; digests: Record<string, string>; nowMs?: number };
    output: PersistedClawMcpServerRef[];
  };
};
