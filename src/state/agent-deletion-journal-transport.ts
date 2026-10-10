import type { Result } from "@openclaw/normalization-core/result";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type { AgentDeletionJournalEntry } from "./agent-deletion-journal.types.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";

export type AgentDeletionInput = Omit<
  AgentDeletionJournalEntry,
  | "createdAt"
  | "operationId"
  | "cleanupCompleted"
  | "databasePaths"
  | "cleanupPaths"
  | "deleteFiles"
> &
  Partial<Pick<AgentDeletionJournalEntry, "databasePaths" | "cleanupPaths" | "deleteFiles">>;

type AgentDeletionJournalMutation =
  | {
      kind: "begin";
      entry: AgentDeletionInput;
      operationId: string;
      expectedJournal: AgentDeletionJournalEntry | null;
    }
  | { kind: "rollback"; journal: AgentDeletionJournalEntry };

export type AgentDeletionJournalTransport = (
  mutation: AgentDeletionJournalMutation,
  authority: {
    identity: OpenClawStateLeaseIdentity;
    sourceIdentity: DatabasePathIdentity;
    signal: AbortSignal;
    assertCurrent: () => void;
  },
) => Promise<Result<AgentDeletionJournalEntry | null, Error>>;
