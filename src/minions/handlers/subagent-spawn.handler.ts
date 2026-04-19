import type { MinionHandler, MinionJobContext } from "../types.js";
import { UnrecoverableError } from "../types.js";

/**
 * Handler for `subagent.spawn` minion jobs. Two modes:
 *
 * 1. **Fresh spawn** (normal path): job.data has `task` but no `childSessionKey`.
 *    Handler calls `spawnSubagentDirect` to launch a new subagent.
 *
 * 2. **Crash recovery** (stall re-queue): job.data has `task` + `childSessionKey`
 *    from a previous attempt that died. Handler re-spawns with the same task.
 *    The old session is gone (gateway cleaned it up or it died), so we spawn fresh.
 *
 * Both modes write progress and token updates back to the minion job for
 * durability and accounting.
 */
export const subagentSpawnHandler: MinionHandler = async (job: MinionJobContext) => {
  const {
    task,
    childSessionKey: previousSessionKey,
    runId: previousRunId,
    label,
    agentId,
    model,
    thinking,
    runTimeoutSeconds,
    cleanup,
    mode,
    lightContext,
  } = job.data as {
    task?: string;
    childSessionKey?: string;
    runId?: string;
    label?: string;
    agentId?: string;
    model?: string;
    thinking?: string;
    runTimeoutSeconds?: number;
    cleanup?: string;
    mode?: string;
    lightContext?: boolean;
    requesterSessionKey?: string;
    requesterChannel?: string;
    requesterAccountId?: string;
    requesterTo?: string;
    requesterThreadId?: string;
  };

  if (!task) {
    throw new UnrecoverableError(
      "subagent.spawn handler requires `task` in job.data",
    );
  }

  const isRetry = job.attemptsMade > 0 || Boolean(previousSessionKey);

  await job.updateProgress({
    phase: isRetry ? "respawning" : "spawning",
    task: task.slice(0, 200),
    attempt: job.attemptsMade + 1,
  });

  try {
    const { spawnSubagentDirect } = await import("../../agents/subagent-spawn.js");

    const result = await spawnSubagentDirect(
      {
        task,
        label: label || undefined,
        agentId,
        model,
        thinking,
        runTimeoutSeconds: typeof runTimeoutSeconds === "number" ? runTimeoutSeconds : undefined,
        mode: mode === "run" || mode === "session" ? mode : undefined,
        cleanup: cleanup === "keep" || cleanup === "delete" ? cleanup : "keep",
        lightContext,
        expectsCompletionMessage: true,
      },
      {},
    );

    if (result.status === "error") {
      throw new Error(result.error ?? "spawnSubagentDirect returned error");
    }

    await job.updateProgress({
      phase: "completed",
      childSessionKey: result.childSessionKey,
      runId: result.runId,
    });

    return {
      status: result.status,
      childSessionKey: result.childSessionKey,
      runId: result.runId,
      wasRetry: isRetry,
    };
  } catch (err) {
    await job.updateProgress({
      phase: "failed",
      error: err instanceof Error ? err.message : String(err),
      attempt: job.attemptsMade + 1,
    });
    throw err;
  }
};

export const SUBAGENT_SPAWN_HANDLER_NAME = "subagent.spawn";
