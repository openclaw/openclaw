import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SessionBranchSwitchMutationResult,
  SessionMessageCutMutationParams,
  SessionMessageCutMutationResult,
} from "./session-accessor.types.js";
import type { SessionNativeBindingParticipants } from "./session-native-binding.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

type SessionMessageCutExpectedState = Pick<SessionEntry, "lifecycleRevision" | "sessionId">;
/** Bundled history mutations carry source authority separately from released SDK arguments. */
export type SessionMessageCutPreconditions = {
  sourceRepositoryWorkspaceId?: string;
  assertUpstreamCurrent?: () => void;
};

export type SessionMessageCutResult =
  | SessionMessageCutMutationResult
  | SessionBranchSwitchMutationResult
  | { status: "conflict" };

export type SessionMessageCutIntent = {
  canonicalSourceKey: string;
  creation?: SessionMessageCutMutationParams["creation"];
  forkWorkspace?: SessionMessageCutMutationParams["forkWorkspace"];
  entryId: string;
  expectedState: SessionMessageCutExpectedState | undefined;
  mode: "fork" | "rewind" | "switch";
  repositoryWorkspaceId?: string;
  sourceKey: string;
  targetKey: string;
};

export type SessionMessageCutCommit = {
  agentId: string;
  intent: SessionMessageCutIntent & { mode: "rewind" | "switch" };
  nativeBindings?: SessionNativeBindingParticipants;
};

export type SessionMessageCutCandidate = {
  kind: "session-message-cut";
  result: SessionMessageCutResult;
  previousSessionIds: string[];
  projectionNeedsReconcile: boolean;
  publication?: SessionEntryReplacementPublication;
};
