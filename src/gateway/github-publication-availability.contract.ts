import type { AgentRunSessionTarget } from "../agents/run-session-target.types.js";
import type { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

export type PublicationSessionIdentity = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision?: string | null;
};

export type ExpectedWorktree = {
  worktreeId: string;
  repositoryFingerprint: string;
  branch: string;
};
export type PublicationSessionRead = Pick<
  ReturnType<typeof loadGatewaySessionEntryReadOnly>,
  "agentId" | "canonicalKey" | "storePath" | "entry"
>;

export type PublicationWorkspaceOptions = {
  sessionTarget?: AgentRunSessionTarget;
  assertCurrent?: () => void;
};

export type PreparedGitHubPublicationWorkspaceOwner<T> = {
  initial: T;
  read: () => Promise<T>;
  current: () => T;
  currentRepository: () => Extract<T, { kind: "repository" }>;
  release: () => void;
};

export const PUBLICATION_SESSION_FIELDS = [
  "sessionId",
  "lifecycleRevision",
  "archivedAt",
  "repositoryWorkspaceId",
  "worktree",
  "owner",
  "createdActor",
  "visibility",
  "incognito",
] as const;
