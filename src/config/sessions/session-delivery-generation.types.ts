import type { SessionSharingEntry } from "./session-accessor.sqlite-entry-cache.types.js";

export type SessionDeliveryGeneration = Readonly<{
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
}>;

export type SessionGenerationEntry = Pick<
  SessionSharingEntry,
  "sessionId" | "lifecycleRevision" | "permissionMode" | "toolOverrides"
>;

export type SessionGenerationFacts = Omit<SessionDeliveryGeneration, "sessionId"> & {
  sessionId: string | null;
  env?: NodeJS.ProcessEnv;
};
