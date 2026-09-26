import type { OpenClawRegisteredAgentDatabase } from "./openclaw-agent-db-contract.js";

export type RetainedAgentDeletion = { agentId: string; agentDir: string; databasePaths: string[] };
export type HeldAgentDatabase = { agentId: string; path: string };
export type AgentDeletionJournalPurpose = "runtime" | "maintenance";

type KnownAgentDeletionFacts = {
  entries: RetainedAgentDeletion[];
  held: HeldAgentDatabase[];
};
export type AgentDeletionJournalDisposition =
  | {
      status: "unavailable";
      cause: "missing" | "unreadable";
      reason: string;
      known?: KnownAgentDeletionFacts;
    }
  | { status: "empty" }
  | ({ status: "present" } & KnownAgentDeletionFacts);

export type AgentDatabaseDeletionSnapshot = {
  retainedDeletions: AgentDeletionJournalDisposition;
  registeredAgentDatabases: OpenClawRegisteredAgentDatabase[];
};

export type AgentDeletionJournalStatus = "absent" | "pending" | "complete";
