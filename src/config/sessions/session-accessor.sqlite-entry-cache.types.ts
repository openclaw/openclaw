import type { SessionEntry } from "./types.js";

export type SessionEntryCacheSnapshot = {
  entries: Map<string, SessionEntry>;
  keys: string[];
};

export type SessionSharingEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "updatedAt"
  | "lifecycleRevision"
  | "visibility"
  | "incognito"
  | "createdActor"
  | "sandbox"
>;
