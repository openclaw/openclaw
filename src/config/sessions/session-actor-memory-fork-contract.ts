import type { ParentForkSourceTranscript } from "./session-accessor.sqlite-parent-fork.js";
import type {
  ForkSessionEntryFromParentTargetParams,
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

export type SessionActorMemoryForkWrites = {
  "session.parentFork.commit": {
    input: {
      kind: "entry";
      params: Omit<ParentForkEntryParams, "agentId" | "storePath">;
      patch?: ParentForkEntryPatch;
      /** Backend support is prepared by the host; bindings come from the current parent. */
      supportsCliFork?: (provider: string) => boolean;
      /** Released callback API runs synchronously inside the memory owner, like its SQL transaction. */
      callbacks?: Pick<
        ForkSessionEntryFromParentTargetParams,
        "patch" | "skipPatch" | "skipForkWhen" | "decisionSkipPatch"
      >;
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
