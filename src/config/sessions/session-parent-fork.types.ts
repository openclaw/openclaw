import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { ParentForkSourceTranscript } from "./session-accessor.sqlite-parent-fork.js";
import type {
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
} from "./session-accessor.types.js";
import type { SessionEntryPatchReceipt } from "./session-entry-patch.types.js";
import type { SessionMessageCutIntent } from "./session-message-cut.types.js";
import type { SessionEntry } from "./types.js";

/** Data-only patches applied to the current child row by its writer. */
export type ParentForkEntryPatch = {
  skipExisting?: boolean;
  skipped?: Partial<SessionEntry>;
  forked?: Partial<SessionEntry>;
};
export type ParentForkEntryParams = Omit<ForkSessionEntryFromParentTargetParams, "commitGuard">;
export type ParentForkEntryPreparation = {
  parentEntry?: SessionEntry;
  base?: SessionEntry;
};
export type ParentForkCommit =
  | {
      kind: "entry";
      agentId: string;
      params: ParentForkEntryParams;
      patch?: ParentForkEntryPatch;
      cliForkProviders?: readonly string[];
    }
  | {
      kind: "transcript";
      agentId: string;
      params: Omit<ForkSessionFromParentTranscriptParams, "commitGuard">;
      source?: ParentForkSourceTranscript | null;
      parentSessionFile?: string;
    };
export type ParentForkCandidate = {
  kind: "session-parent-fork";
  result: ForkSessionEntryFromParentTargetResult | ForkSessionFromParentTranscriptResult;
  publication?: SessionEntryReplacementPublication;
};

export type SessionForkMessageCutCommit = {
  agentId: string;
  intent: SessionMessageCutIntent & { mode: "fork" };
  sourceRepositoryWorkspaceId?: string;
};

export type SessionForkOperations = {
  "session.parentFork.prepare": {
    input: ParentForkEntryParams;
    output: ParentForkEntryPreparation;
  };
  "session.parentFork.source": {
    input: { sessionId: string; forkFrom?: "last-completed" };
    output: ParentForkSourceTranscript | null;
  };
  "session.parentFork.commit": { input: ParentForkCommit; output: SessionEntryPatchReceipt };
  "session.messageCut.fork": {
    input: SessionForkMessageCutCommit;
    output: ReturnType<
      typeof import("./session-message-cut.worker.js").commitSessionForkMessageCut
    >;
  };
};
