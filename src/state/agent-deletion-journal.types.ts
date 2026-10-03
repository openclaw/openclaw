import type { OpenClawRegisteredAgentDatabase } from "./openclaw-agent-db-contract.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";

export type AgentDeletionWorkerWriteFacts = {
  databasePath: string;
  agentId: string;
  operationId: string;
  lease: OpenClawStateLeaseIdentity;
};

export type AgentDeletionWorkerWriteAuthority = {
  facts: AgentDeletionWorkerWriteFacts;
  assertCurrent: () => void;
};

export type RetainedAgentDeletion = { agentId: string; agentDir: string; databasePaths: string[] };
export type HeldAgentDatabase = { agentId: string; path: string };
export type AgentDeletionRecoveryHoldPredicate = {
  agentId: string;
  held: readonly HeldAgentDatabase[];
  applies: boolean;
};
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

export type AgentDeletionJournalAuthority = Readonly<{
  agentId: string;
  operationId: string;
  cleanupCompleted: boolean;
}>;

export type AgentDeletionJournalCleanupPath = {
  path: string;
  canonicalPath: string;
  parentPath: string;
  kind: "target" | "symlink";
  sourcePaths: string[];
  dev: number | null;
  ino: number | null;
  coversDescendants: boolean;
  done: boolean;
  note?: string;
};

export type AgentDeletionJournalEntry = {
  agentId: string;
  operationId: string;
  agentDir: string;
  workspaceDir: string;
  sessionsDir: string;
  databasePaths: string[];
  cleanupPaths: AgentDeletionJournalCleanupPath[];
  createdAt: number;
  cleanupCompleted: boolean;
  deleteFiles: boolean;
};
