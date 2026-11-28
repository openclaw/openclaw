import type { ChatRef } from "../../sessions/chat-ref.js";
import type {
  SessionEntryCreationOperation,
  SessionSharingEntry,
} from "./session-accessor.sqlite-entry-cache.types.js";
import type { SessionSourceAssertion } from "./session-source-authority.js";

export type SessionGenerationEntry = Pick<
  SessionSharingEntry,
  "sessionId" | "lifecycleRevision" | "permissionMode" | "toolOverrides"
>;

/** The transcript a live writer holds. Only `TranscriptLease` takes one. */
export type TranscriptPin = { sessionId: string | null; lifecycleRevision?: string | null };

/** Lease input inside this module. Other modules pass a `ChatRef` and, for a writer, a pin. */
export type LeaseFacts = Pick<ChatRef, "agentId" | "storePath" | "sessionKey"> & {
  env?: NodeJS.ProcessEnv;
  /** Null: the chat must not exist yet. Omitted: any transcript of the key. */
  sessionId?: string | null;
  lifecycleRevision?: string | null;
  /** A writer holds its exact transcript; a scheduled occurrence holds its incarnation. */
  exact?: "transcript" | "lifecycle";
};

/**
 * A chat lease follows the key to the current transcript. A transcript lease holds the
 * writer's transcript, or a scheduled occurrence's incarnation. A null session id leases
 * the row's absence.
 */
export function matchesSessionGeneration(
  input: Pick<LeaseFacts, "sessionId" | "lifecycleRevision" | "exact">,
  entry: Pick<SessionGenerationEntry, "sessionId" | "lifecycleRevision"> | null | undefined,
): boolean {
  if (!entry || input.sessionId === null) {
    return Boolean(entry) !== (input.sessionId === null);
  }
  return (
    !input.exact ||
    ((input.exact === "lifecycle" || entry.sessionId === input.sessionId) &&
      (entry.lifecycleRevision ?? null) === (input.lifecycleRevision ?? null))
  );
}

export type SessionGenerationLease = {
  assertCurrent: SessionSourceAssertion;
  assertNativeTransactionCurrent: SessionSourceAssertion;
  assertDeliveryCurrent: () => void;
  readSessionSettings: () => Readonly<SessionGenerationEntry> | undefined;
  prepareRead: () => Promise<void> | undefined;
  release: () => void;
  bindCreation: (
    operation: SessionEntryCreationOperation,
    publishBinding?: (
      binding: Pick<SessionGenerationEntry, "sessionId" | "lifecycleRevision">,
    ) => void,
  ) => SessionSourceAssertion;
  isCreationAdopted: () => boolean;
};
