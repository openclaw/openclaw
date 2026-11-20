import type { SessionEntry } from "../../config/sessions/types.js";

export type GoalContinuation = Pick<SessionEntry, "sessionId" | "lifecycleRevision"> & {
  goalId: string;
  workerGoal?: true;
  workerDispatch?: <T>(
    identity: { agentId: string; sessionKey: string; sessionId: string; runId: string },
    run: () => Promise<T>,
  ) => Promise<T>;
  localCodexGoal?: true;
};
