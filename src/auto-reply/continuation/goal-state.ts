import { updateSessionStoreEntry } from "../../config/sessions.js";
import type { GoalState } from "./types.js";

export async function persistGoalState(params: {
  storePath: string;
  sessionKey: string;
  goal: GoalState;
}): Promise<void> {
  await updateSessionStoreEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    update: async (entry) => ({
      ...entry,
      activeGoal: params.goal,
    }),
  });
}

export async function clearGoalState(params: {
  storePath: string;
  sessionKey: string;
}): Promise<void> {
  await updateSessionStoreEntry({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    update: async (entry) => {
      const { activeGoal: _, ...rest } = entry;
      return rest;
    },
  });
}
