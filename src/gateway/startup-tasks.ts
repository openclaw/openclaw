import { formatErrorMessage } from "../infra/errors.js";

type StartupTaskResult =
  | { status: "skipped"; reason: string }
  | { status: "ran" }
  | { status: "failed"; reason: string };

export type StartupTask = {
  /** Human-readable task source used in startup logs. */
  source: string;
  /** Optional agent id that owns this startup task. */
  agentId?: string;
  /** Optional session key associated with this startup task. */
  sessionKey?: string;
  /** Optional workspace directory used by this startup task. */
  workspaceDir?: string;
  /** Execute the task and report whether it ran, skipped, or failed. */
  run: () => Promise<StartupTaskResult>;
};

type StartupTaskLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

function taskMeta(task: StartupTask, result?: StartupTaskResult): Record<string, unknown> {
  return {
    source: task.source,
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.sessionKey ? { sessionKey: task.sessionKey } : {}),
    ...(task.workspaceDir ? { workspaceDir: task.workspaceDir } : {}),
    ...(result?.status === "failed" || result?.status === "skipped"
      ? { reason: result.reason }
      : {}),
  };
}

/** Run startup tasks sequentially and log skipped/failed outcomes with task metadata. */
export async function runStartupTasks(params: {
  /** Ordered startup tasks to execute. */
  tasks: StartupTask[];
  /** Logger used for skipped and failed task metadata. */
  log: StartupTaskLogger;
}): Promise<StartupTaskResult[]> {
  const results: StartupTaskResult[] = [];
  for (const task of params.tasks) {
    let result: StartupTaskResult;
    try {
      result = await task.run();
    } catch (err) {
      result = { status: "failed", reason: formatErrorMessage(err) };
    }
    results.push(result);
    if (result.status === "failed") {
      params.log.warn("startup task failed", taskMeta(task, result));
      continue;
    }
    if (result.status === "skipped") {
      params.log.debug("startup task skipped", taskMeta(task, result));
    }
  }
  return results;
}
