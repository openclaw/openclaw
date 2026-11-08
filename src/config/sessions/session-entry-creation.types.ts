import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionEntry } from "./types.js";

/** Facts published by the writer after its absent-row creation commits. */
export type SessionEntryCreationCommit = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
  lifecycleRevision?: string;
  readSource: CapturedSessionEntryReadSource;
  entry: SessionEntry;
};
