// Continuation (karmaterminal): session-entry fields the continuation feature persists, split from
// types.ts to keep that file under its line cap.
import type { InlineAttachment, InlineAttachmentMount } from "../../shared/inline-attachments.js";
import type { ContinuationRecipientAuthorityBinding } from "./session-recipient-authority-types.js";

export type SessionPostCompactionDelegate = {
  task: string;
  createdAt: number;
  /** Stable original arm time, preserved across re-stage/restart cycles. */
  firstArmedAt?: number;
  /** Post-compaction delegates are silent by contract; persist the intent across store round trips. */
  silent?: boolean;
  silentWake?: boolean;
  attachments?: InlineAttachment[];
  attachAs?: InlineAttachmentMount;
  targetSessionKey?: string;
  targetSessionKeys?: string[];
  fanoutMode?: "tree" | "all";
  /** Durable logical-mailbox authority captured before this delegate was accepted. */
  recipientAuthorityBinding?: ContinuationRecipientAuthorityBinding;
  traceparent?: string;
  /** Persisted proof that traceparent came from a runtime-owned capture boundary. */
  traceparentProvenance?: "internal";
  /** Optional provider/model override forwarded to the released delegate; omitted => inherit parent. */
  model?: string;
  /**
   * Runtime-only custody claim handle for a delegate just released by
   * consumeStagedPostCompactionDelegates. Used to finalize or fail exactly the
   * claimed row after a durable handoff; never persisted in session entries.
   */
  flowId?: string;
  expectedRevision?: number;
};

export type SessionEntryContinuationFields = {
  /** Internal one-shot traceparent for a freshly spawned child agent run. */
  continuationTraceparent?: string;
  /**
   * Last context-pressure band that fired: a window percentage for runtimes that own
   * compaction (e.g. 80, 90, 95), an ordinal warning (1, 2) on the built-in runtime.
   * Used to deduplicate pressure events until the session crosses into another band.
   */
  lastContextPressureBand?: number;
  /** Number of continuation turns completed in the current chain. Reset on external message. */
  continuationChainCount?: number;
  /** Timestamp (ms) when the current continuation chain started. */
  continuationChainStartedAt?: number;
  /** Accumulated token usage across the current continuation chain. Reset on external message. */
  continuationChainTokens?: number;
  /** Stable identifier for the current continuation chain, persisted across compaction. */
  continuationChainId?: string;
  /** Post-compaction delegates staged for execution after context compaction. */
  pendingPostCompactionDelegates?: SessionPostCompactionDelegate[];
};
