import type { SessionGoalOperation } from "./goals-operations.types.js";
import type { SessionTranscriptWriteScope } from "./session-accessor.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type { SqliteSessionTurnOptions } from "./session-turn.types.js";

type SessionColdTurnGuard = {
  kind: "turn";
  sources?: SessionSourcePredicate[];
  requireActive?: boolean;
  agentId: string;
  sessionKey: string;
  options: Pick<
    SqliteSessionTurnOptions,
    | "keyFormat"
    | "expectedSessionId"
    | "selectedSessionId"
    | "selectedLifecycleRevision"
    | "expectedLifecycleRevision"
    | "expectedWriterRunId"
    | "expectedSessionState"
    | "initialSessionEntry"
  >;
  goalOperation?: SessionGoalOperation;
};

export type SessionColdLockedGuard = {
  kind: "locked";
  agentId: string;
  sessionKey: string;
  sources: SessionSourcePredicate[];
  fence: Pick<
    SessionTranscriptWriteScope,
    "expectedOwner" | "expectedLifecycleRevision" | "expectedWriterRunId"
  >;
};

export type SessionColdRestorationGuard = SessionColdTurnGuard | SessionColdLockedGuard;
