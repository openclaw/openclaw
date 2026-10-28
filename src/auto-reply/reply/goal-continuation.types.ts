import type { SessionEntry } from "../../config/sessions/types.js";

export type GoalContinuation = Pick<SessionEntry, "sessionId" | "lifecycleRevision"> & {
  goalId: string;
  workerGoal?: true;
};
