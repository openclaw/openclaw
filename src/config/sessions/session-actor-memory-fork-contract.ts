import type { ParentForkSourceTranscript } from "./session-accessor.sqlite-parent-fork.js";
import type { ForkSessionEntryFromParentTargetResult } from "./session-accessor.types.js";
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
      cliForkProviders?: readonly string[];
    };
    output: ForkSessionEntryFromParentTargetResult;
  };
  "session.messageCut": {
    input: { intent: SessionMessageCutIntent; sourceRepositoryWorkspaceId?: string };
    output: SessionMessageCutResult;
  };
};
