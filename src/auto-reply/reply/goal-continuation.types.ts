import type { SessionEntry } from "../../config/sessions/types.js";
import type { captureRepositoryGoalDispatch } from "../../gateway/repository-dispatch.js";

export type GoalContinuation = Pick<SessionEntry, "sessionId" | "lifecycleRevision"> & {
  goalId: string;
  workerGoal?: true;
  workerDispatch?: ReturnType<typeof captureRepositoryGoalDispatch>;
  localCodexGoal?: true;
};
