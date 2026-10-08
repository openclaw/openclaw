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
} from "./session-source-authority.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryPatchSelection =
  | { kind: "entry"; sessionKey: string; exact: boolean }
  | { kind: "target"; target: { canonicalKey: string; storeKeys: string[] } };

export type SessionEntryPatchGuard = {
  /** Storage reads prepare before submission; grants consume the prepared host authority. */
  source?: SessionSourceAssertion;
  /** Retained host authority; same-store predicates belong in the worker transaction. */
  assertCurrent?: () => void;
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
};

export type SessionEntryPatchCommitted = {
  kind: "session-entry-patch";
  entry: SessionEntry | null;
  publication?: SessionEntryReplacementPublication;
  refusedSource?: { index: number; facts: SessionSourcePredicateFacts };
};

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
