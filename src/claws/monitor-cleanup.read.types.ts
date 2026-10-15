import type { AgentDeletionJournalEntry } from "../state/agent-deletion-journal.types.js";
import type { PersistedClawCronRef } from "./cron.types.js";
import type { PortableHeartbeatState } from "./portable-heartbeat-state.types.js";
import type { PersistedClawInstall } from "./provenance-types.js";

export type AttachedCronJob = {
  id: string;
  name: string;
  enabled: boolean;
  agentId: string | null;
  ownerAgentId: string | null;
  storeKey: string;
  declarationKey: string | null;
  revision?: string;
};

export type ClawMonitorCleanupSnapshot = {
  journal: AgentDeletionJournalEntry | undefined;
  install: PersistedClawInstall | undefined;
  attached: AttachedCronJob[];
  refs: PersistedClawCronRef[];
  portable: { jobId: string | undefined; owned: boolean; stateDigest: string };
};

export type ClawMonitorCleanupReadOperations = {
  "clawMonitorCleanup.snapshot": {
    input: { agentId: string; storePath: string; defaultAgentId?: string };
    output: { type: "clawMonitorCleanup.snapshot"; snapshot: ClawMonitorCleanupSnapshot };
  };
  "clawMonitorCleanup.portable": {
    input: { agentId: string; storePath: string | undefined };
    output: { type: "clawMonitorCleanup.portable"; state: PortableHeartbeatState };
  };
};
