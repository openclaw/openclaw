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
  /**
   * Rounded ids, kept numeric so a downgrade mid-deletion still parses this
   * journal. v2026.8.2 and earlier accept only `number | null` here, and their
   * own recheck refuses to act on an id past the safe integer range, so they
   * fail closed instead of trusting a rounded match.
   */
  dev: number | null;
  ino: number | null;
  /** Exact decimal ids. NTFS file ids do not survive a double. */
  devExact?: string | null;
  inoExact?: string | null;
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

export type AgentDeletionJournalInput = Omit<
  AgentDeletionJournalEntry,
  "createdAt" | "cleanupCompleted" | "databasePaths" | "cleanupPaths"
> & {
  databasePaths?: string[];
  cleanupPaths?: AgentDeletionJournalCleanupPath[];
};
