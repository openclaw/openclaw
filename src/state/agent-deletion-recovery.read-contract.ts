import type {
  AgentDeletionJournalEntry,
  HeldAgentDatabase,
} from "./agent-deletion-journal.types.js";

export type AgentRecoveryReadOperations = {
  "agentRecovery.holds": {
    input: { statePath: string };
    output: { type: "agentRecovery.holds"; held: HeldAgentDatabase[] };
  };
  "agentRecovery.pendingDeletions": {
    input: undefined;
    output: {
      type: "agentRecovery.pendingDeletions";
      entries: AgentDeletionJournalEntry[];
      manualClawAgentIds: string[];
    };
  };
  "agentRecovery.creationJournal": {
    input: { agentId: string };
    output: {
      type: "agentRecovery.creationJournal";
      journal: AgentDeletionJournalEntry | undefined;
    };
  };
};
