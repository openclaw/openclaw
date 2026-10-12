import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
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

/** Bundled transformations; opaque released callbacks keep their native transaction. */
export type ParentForkEntryPatch = {
  skipExisting?: boolean;
  skipped?: Partial<SessionEntry>;
  forked?: Partial<SessionEntry>;
};
export type ParentForkEntryParams = Omit<
  ForkSessionEntryFromParentTargetParams,
  "patch" | "skipPatch" | "skipForkWhen" | "decisionSkipPatch" | "commitGuard"
>;
export type ParentForkEntryPreparation = {
  parent: SqliteLifecycleTargetSnapshot;
  child: SqliteLifecycleTargetSnapshot;
  parentEntry?: SessionEntry;
  base?: SessionEntry;
};
export type ParentForkCommit =
  | {
      kind: "entry";
      agentId: string;
      params: ParentForkEntryParams;
      prepared: ParentForkEntryPreparation;
      patch?: ParentForkEntryPatch;
      cliSessionBindings?: SessionEntry["cliSessionBindings"];
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
