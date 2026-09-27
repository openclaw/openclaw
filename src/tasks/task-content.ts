import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import {
  SUBAGENT_KILL_TASK_ERROR,
  type DetachedTaskTerminalState,
} from "./detached-task-runtime-contract.js";

type TaskContent = {
  task?: string;
  label?: string;
  progressSummary?: string | null;
  terminalSummary?: string | null;
  eventSummary?: string | null;
  error?: string;
};

const BACKGROUND_COMMAND_TASK_SUMMARIES = {
  succeeded: "Command completed",
  failed: "Command failed",
  cancelled: "Command stopped",
  timed_out: "Command timed out",
} satisfies Record<DetachedTaskTerminalState["status"], string>;

// Fixed lifecycle text carries no conversation content, so Incognito rows keep it.
const CONTENT_FREE_TERMINAL_SUMMARIES = new Set<string>(
  Object.values(BACKGROUND_COMMAND_TASK_SUMMARIES),
);

export function backgroundCommandTaskSummary(status: DetachedTaskTerminalState["status"]) {
  return BACKGROUND_COMMAND_TASK_SUMMARIES[status];
}

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
  const keepTerminalSummary =
    params.terminalSummary == null || CONTENT_FREE_TERMINAL_SUMMARIES.has(params.terminalSummary);
  return {
    ...params,
    ...(params.task !== undefined ? { task: "Incognito task" } : {}),
    ...(params.label !== undefined ? { label: "Incognito task" } : {}),
    ...(params.progressSummary !== undefined ? { progressSummary: null } : {}),
    ...(keepTerminalSummary ? {} : { terminalSummary: null }),
    ...(params.eventSummary !== undefined ? { eventSummary: null } : {}),
    ...(params.error !== undefined
      ? {
          error: params.error === SUBAGENT_KILL_TASK_ERROR ? params.error : "Incognito task error.",
        }
      : {}),
  };
}
