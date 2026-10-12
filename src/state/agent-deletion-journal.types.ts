import type { OpenClawRegisteredAgentDatabase } from "./openclaw-agent-db-contract.js";

export type RetainedAgentDeletion = {
  agentId: string;
  agentDir: string;
  databasePaths: string[];
  cleanupCompleted: boolean;
  manualClawRemoval?: true;
};
export type HeldAgentDatabase = { agentId: string; path: string };
export type AgentDeletionJournalPurpose = "runtime" | "maintenance";
export type AgentDeletionJournalPhase = "draining" | "retiring";

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

export type AgentDatabaseDeletionWorkerSnapshot = AgentDatabaseDeletionSnapshot & {
  deletedAgents: Array<{ agentId: string; status: "pending" | "complete" }>;
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
  phase: AgentDeletionJournalPhase;
  agentDir: string;
  workspaceDir: string;
  sessionsDir: string;
  databasePaths: string[];
  cleanupPaths: AgentDeletionJournalCleanupPath[];
  createdAt: number;
  cleanupCompleted: boolean;
  deleteFiles: boolean;
};

export type AgentDeletionJournalInput = Omit<
  AgentDeletionJournalEntry,
  "createdAt" | "cleanupCompleted" | "databasePaths" | "cleanupPaths" | "phase"
> & {
  phase?: AgentDeletionJournalPhase;
  databasePaths?: string[];
  cleanupPaths?: AgentDeletionJournalCleanupPath[];
};
