import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";

type TaskContent = {
  task?: string;
  label?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  eventSummary?: string | null;
  error?: string;
};

export function isIncognitoTask(identity: {
  requesterSessionKey?: string;
  ownerKey?: string;
  childSessionKey?: string | null;
}): boolean {
  return (
    isIncognitoSessionKey(identity.requesterSessionKey) ||
    isIncognitoSessionKey(identity.ownerKey) ||
    isIncognitoSessionKey(identity.childSessionKey ?? undefined)
  );
}

/** Keep lifecycle receipts durable, not their temporary conversation content. */
export function projectTaskContentForPersistence<T extends TaskContent>(
  incognito: boolean,
  params: T,
): T {
  if (!incognito) {
    return params;
  }
  return {
    ...params,
    ...(params.task !== undefined ? { task: "Incognito task" } : {}),
    ...(params.label !== undefined ? { label: "Incognito task" } : {}),
    ...(params.progressSummary !== undefined ? { progressSummary: null } : {}),
    ...(params.terminalSummary !== undefined ? { terminalSummary: null } : {}),
    ...(params.eventSummary !== undefined ? { eventSummary: null } : {}),
    ...(params.error !== undefined
      ? {
          error: params.error === SUBAGENT_KILL_TASK_ERROR ? params.error : "Incognito task error.",
        }
      : {}),
  };
}
