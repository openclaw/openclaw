import type { AgentDeletionJournalEntry } from "./agent-deletion-journal.types.js";

export type AgentRecoveryReadOperations = {
  "agentRecovery.creationJournal": {
    input: { agentId: string };
    output: {
      type: "agentRecovery.creationJournal";
      journal: AgentDeletionJournalEntry | undefined;
    };
  };
};
