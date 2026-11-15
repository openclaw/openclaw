import type { ParentForkSourceTranscript } from "./session-accessor.sqlite-parent-fork.js";
import type {
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptResult,
} from "./session-accessor.types.js";
import type {
  SessionMessageCutIntent,
  SessionMessageCutResult,
} from "./session-message-cut.types.js";
import type { ParentForkEntryParams, ParentForkEntryPatch } from "./session-parent-fork.types.js";

export type SessionActorMemoryForkReads = {
  "session.parentFork.source": {
    input: { sessionKey?: string; sessionId?: string; forkFrom?: "last-completed" };
    output: ParentForkSourceTranscript | null;
  };
};

/** CLI capability lookup stays with the host; entry patches are command data. */
export type SessionActorMemoryParentForkCallbacks = {
  supportsCliFork?: (provider: string) => boolean;
};

export type SessionActorMemoryForkWrites = {
  "session.parentFork.commit": {
    input: {
      kind: "entry";
      params: Omit<ParentForkEntryParams, "agentId" | "storePath">;
      patch?: ParentForkEntryPatch;
    };
    output: ForkSessionEntryFromParentTargetResult;
  };
  "session.parentFork.transcript": {
    input: { sessionId: string; events: readonly unknown[] };
    output: Extract<ForkSessionFromParentTranscriptResult, { status: "created" }>;
  };
  "session.messageCut": {
    input: { intent: SessionMessageCutIntent; sourceRepositoryWorkspaceId?: string };
    output: SessionMessageCutResult;
  };
};

export type SessionActorMemoryForkQuery = {
  [Key in keyof SessionActorMemoryForkReads]: {
    type: Key;
    input: SessionActorMemoryForkReads[Key]["input"];
  };
}[keyof SessionActorMemoryForkReads];

export type SessionActorMemoryForkCommand = {
  [Key in keyof SessionActorMemoryForkWrites]: {
    type: Key;
    input: SessionActorMemoryForkWrites[Key]["input"];
  };
}[keyof SessionActorMemoryForkWrites];
