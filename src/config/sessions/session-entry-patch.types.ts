import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { ConversationAuthority } from "./conversation-authority.types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type { SessionEntryPatchOperation } from "./session-entry-patch-operation.js";
import type { SessionTranscriptWatermark } from "./session-history-read.types.js";
import type {
  SessionSourceAssertion,
  SessionSourcePredicate,
  SessionSourcePredicateFacts,
  SessionSourceTransactionGrant,
} from "./session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryPatchSelection =
  | { kind: "entry"; sessionKey: string; exact: boolean }
  | { kind: "target"; target: { canonicalKey: string; storeKeys: string[] } };

export type SessionEntryPatchGuard = {
  /** Storage reads prepare before submission; grants consume the prepared host authority. */
  source?: SessionSourceAssertion;
  /** Closed ensure only; its caller revalidates the published identity before effects. */
  ensureIdentitySource?: SessionSourceTransactionGrant;
  /** Retained host authority; same-store predicates belong in the worker transaction. */
  assertCurrent?: () => void;
  /** Check live effect authority at native write and commit grants, never during preparation. */
  assertMutationAllowed?: () => void;
  /** Same-store route authority is reread inside the worker's write transaction. */
  conversation?: ConversationAuthority;
  cliHistory?: {
    sessionId: string;
    admission?: UserTurnTranscriptAdmissionReceipt;
    watermark: SessionTranscriptWatermark;
  };
  shouldCommitIf?: {
    kind: "transcript";
    sessionId: string;
    generation: string | null;
    leafEntryId: string | null;
  };
};

export type SessionEntryPatchCommit = {
  selection: SessionEntryPatchSelection;
  prepared: SqliteLifecycleTargetSnapshot;
  sessionKey: string;
  writeBase: SessionEntry;
  next: SessionEntry | undefined;
  operationLabel: "session-entry.patch" | "session-entry-target.patch";
  validateCanonicalKeys: boolean;
  consumePendingReset?: boolean;
  providerReviewMutation?: boolean;
  shouldCommitIf?: SessionEntryPatchGuard["shouldCommitIf"];
  cliHistory?: SessionEntryPatchGuard["cliHistory"];
  conversation?: SessionEntryPatchGuard["conversation"];
  sources?: SessionSourcePredicate[];
  ensureIdentitySource?: Omit<SessionSourceTransactionGrant, "assertCurrent">;
};

export type SessionEntryPatchCommitted = {
  kind: "session-entry-patch";
  entry: SessionEntry | null;
  applied: boolean;
  publication?: SessionEntryReplacementPublication;
  /** Guard snapshot before the entry patch, carried only while the session ID is unchanged. */
  transcriptPredicate?: {
    sessionId: string;
    watermark: SessionTranscriptWatermark;
  };
  refusedSource?: { index: number; facts: SessionSourcePredicateFacts };
};

export type SessionEntryPatchCommitObserver = (
  entry: SessionEntry,
  /** Historical predicate facts from the committed transaction, never current authority. */
  transcriptPredicate?: SessionEntryPatchCommitted["transcriptPredicate"],
) => void;

export type SessionEntryPatchReduction = Omit<
  SessionEntryPatchCommit,
  "prepared" | "writeBase" | "next"
> & {
  operation: SessionEntryPatchOperation;
  fallbackEntry?: SessionEntry;
  replaceEntry?: boolean;
  preserveActivity?: boolean;
};

export type SessionEntryPatchReceipt = {
  kind: "session-entry-patch-committed";
  transferId: number;
};
