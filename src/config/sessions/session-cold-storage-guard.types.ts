import type { SessionGoalOperation } from "./goals-operations.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type { SqliteSessionTurnOptions } from "./session-turn.types.js";

export type SessionColdTurnGuard = {
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
