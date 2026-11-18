import type { ChatRef } from "../../sessions/chat-ref.js";
import type { SessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";

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
