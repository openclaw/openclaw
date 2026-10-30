/** Timeout watchdogs for cron runner setup and execution phases. */
import { raceWithTimeout } from "@openclaw/retry";
import type {
  CronAgentExecutionPhase,
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronJob,
} from "../types.js";
import {
  preExecutionTimeoutErrorMessage,
  setupTimeoutErrorMessage,
  timeoutErrorMessage,
} from "./execution-errors.js";
import type { CronServiceState } from "./state.js";

const CRON_TIMEOUT_CLEANUP_GUARD_MS = 20_000;
export const CRON_AGENT_SETUP_WATCHDOG_MS = 60_000;
const CRON_AGENT_PRE_EXECUTION_WATCHDOG_MS = 60_000;
const CRON_AGENT_PRE_EXECUTION_MIN_WATCHDOG_MS = 1_000;

type CronAgentWatchdogState =
  | "waiting_for_runner"
  | "waiting_for_initial_progress"
  | "waiting_for_fallback_execution"
  | "executing"
  | "timed_out"
  | "disposed";

type CronAgentPhaseWatchdogStage = "pre_execution" | "execution";

// Phase ordering is not strictly monotonic during fallback attempts, so each
// emitted phase is mapped to the watchdog bucket that should keep timing it.
const CRON_AGENT_PHASE_WATCHDOG_STAGE = {
  runner_entered: "pre_execution",
  workspace: "pre_execution",
  runtime_plugins: "pre_execution",
  before_agent_reply: "execution",
  model_resolution: "pre_execution",
  auth: "pre_execution",
  context_engine: "pre_execution",
  attempt_dispatch: "execution",
  context_assembled: "execution",
  turn_accepted: "execution",
  process_spawned: "execution",
  tool_execution_started: "execution",
  assistant_output_started: "execution",
  model_call_started: "execution",
} as const satisfies Record<CronAgentExecutionPhase, CronAgentPhaseWatchdogStage>;

/** Tracks runner setup/execution progress and fires the owning timeout reason. */
export function createCronAgentWatchdog(params: {
  executionKind?: "agent" | "command";
  deferUntilRunner: boolean;
  jobTimeoutMs: number;
  triggerTimeout: (reason: string) => void;
}) {
  let state: CronAgentWatchdogState = params.deferUntilRunner ? "waiting_for_runner" : "executing";
  let timeoutId: NodeJS.Timeout | undefined;
  let setupTimeoutId: NodeJS.Timeout | undefined;
  let persistenceTimeoutId: NodeJS.Timeout | undefined;
  let preExecutionTimeoutId: NodeJS.Timeout | undefined;
  let activeExecution: CronAgentExecutionStarted | undefined;
  let waitingForLane = false;
  let waitingForPersistence = false;

  const setTimedOut = (reason: string) => {
    if (state === "timed_out" || state === "disposed") {
      return;
    }
    state = "timed_out";
    params.triggerTimeout(reason);
  };
  const startTimeout = () => {
    if (timeoutId || state === "disposed") {
      return;
    }
    timeoutId = setTimeout(() => {
      setTimedOut(timeoutErrorMessage(activeExecution));
    }, params.jobTimeoutMs);
  };
  const clearSetupTimeout = () => {
    if (!setupTimeoutId) {
      return;
    }
    clearTimeout(setupTimeoutId);
    setupTimeoutId = undefined;
  };
  const clearPersistenceTimeout = () => {
    if (!persistenceTimeoutId) {
      return;
    }
    clearTimeout(persistenceTimeoutId);
    persistenceTimeoutId = undefined;
  };
  // Queue contention is not runner setup; admission must begin a fresh setup budget.
  const startSetupTimeout = () => {
    if (
      setupTimeoutId ||
      state !== "waiting_for_runner" ||
      waitingForLane ||
      waitingForPersistence
    ) {
      return;
    }
    setupTimeoutId = setTimeout(() => {
      if (state === "waiting_for_runner" && !waitingForLane && !waitingForPersistence) {
        setTimedOut(
          params.executionKind === "command"
            ? `${timeoutErrorMessage()} (command setup before runner start)`
            : setupTimeoutErrorMessage(activeExecution),
        );
      }
    }, CRON_AGENT_SETUP_WATCHDOG_MS);
  };
  const clearPreExecutionTimeout = () => {
    if (!preExecutionTimeoutId) {
      return;
    }
    clearTimeout(preExecutionTimeoutId);
    preExecutionTimeoutId = undefined;
  };
  const isWaitingForExecution = () =>
    state === "waiting_for_initial_progress" || state === "waiting_for_fallback_execution";
  const startPreExecutionTimeout = () => {
    if (preExecutionTimeoutId || !isWaitingForExecution()) {
      return;
    }
    preExecutionTimeoutId = setTimeout(() => {
      if (isWaitingForExecution()) {
        setTimedOut(preExecutionTimeoutErrorMessage(activeExecution));
      }
    }, resolveCronAgentPreExecutionWatchdogMs(params.jobTimeoutMs));
  };
  const noteExecutionProgress = (info?: CronAgentExecutionStarted) => {
    if (!info) {
      return;
    }
    activeExecution = { ...activeExecution, ...info };
    const stage = info.phase ? CRON_AGENT_PHASE_WATCHDOG_STAGE[info.phase] : undefined;
    const observedInitialProgress =
      state === "waiting_for_initial_progress" &&
      info.phase !== undefined &&
      info.phase !== "runner_entered";
    const observedFallbackExecution =
      state === "waiting_for_fallback_execution" && stage === "execution";
    if (observedInitialProgress || observedFallbackExecution) {
      state = "executing";
      clearPreExecutionTimeout();
    }
  };

  return {
    start: () => {
      if (params.deferUntilRunner) {
        startSetupTimeout();
        return;
      }
      startTimeout();
    },
    noteLaneWait: () => {
      if (state === "waiting_for_runner") {
        waitingForLane = true;
        clearSetupTimeout();
      }
    },
    noteLaneAdmitted: () => {
      if (state === "waiting_for_runner") {
        waitingForLane = false;
        startSetupTimeout();
      }
    },
    // Session-preparation storage writes can outlast a clean setup budget on a slow
    // volume. Bound the pause by the same setup budget so a hung write still times out,
    // and keep lane-wait attribution untouched.
    notePersistenceWait: () => {
      if (state !== "waiting_for_runner") {
        return;
      }
      waitingForPersistence = true;
      clearSetupTimeout();
      clearPersistenceTimeout();
      persistenceTimeoutId = setTimeout(() => {
        if (state === "waiting_for_runner" && !waitingForLane && waitingForPersistence) {
          setTimedOut(setupTimeoutErrorMessage(activeExecution));
        }
      }, CRON_AGENT_SETUP_WATCHDOG_MS);
    },
    notePersistenceResumed: () => {
      if (state === "waiting_for_runner") {
        waitingForPersistence = false;
        clearPersistenceTimeout();
        startSetupTimeout();
      }
    },
    noteRunnerStarted: (info?: CronAgentExecutionStarted) => {
      if (state === "disposed" || state === "timed_out") {
        return;
      }
      clearSetupTimeout();
      clearPersistenceTimeout();
      waitingForPersistence = false;
      startTimeout();
      if (params.executionKind === "command") {
        state = "executing";
        clearPreExecutionTimeout();
        noteExecutionProgress(info);
        return;
      }
      if (info?.isFallback === true) {
        clearPreExecutionTimeout();
        state = "waiting_for_fallback_execution";
      } else if (state === "waiting_for_runner") {
        state = "waiting_for_initial_progress";
      }
      noteExecutionProgress(info);
      startPreExecutionTimeout();
    },
    notePhase: (info: CronAgentExecutionPhaseUpdate) => {
      if (state === "disposed" || state === "timed_out") {
        return;
      }
      noteExecutionProgress(info);
    },
    activeExecution: () => activeExecution,
    observedLaneWait: () => waitingForLane,
    dispose: () => {
      state = "disposed";
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      clearSetupTimeout();
      clearPersistenceTimeout();
      clearPreExecutionTimeout();
    },
  };
}

export type CronAgentWatchdog = ReturnType<typeof createCronAgentWatchdog>;
export type CronWatchdogWaitSignal = {
  waiting?: boolean;
  stage?: "session-preparation" | "session-persistence";
};

/**
 * Controller-admission waits keep the setup watchdog paused indefinitely; persistence
 * waits get a bounded allowance so a hung storage write still times out.
 */
export function applyCronWatchdogWaitSignal(
  watchdog: CronAgentWatchdog | undefined,
  info?: CronWatchdogWaitSignal,
): void {
  if (!watchdog) {
    return;
  }
  if (info?.stage === "session-persistence") {
    if (info.waiting === false) {
      watchdog.notePersistenceResumed();
    } else {
      watchdog.notePersistenceWait();
    }
    return;
  }
  if (info?.waiting === false) {
    watchdog.noteLaneAdmitted();
    return;
  }
  watchdog.noteLaneWait();
}

/** Joins timeout cleanup and command settlement without wedging the cron lane. */
export async function settleTimedOutCronRun(
  state: CronServiceState,
  job: CronJob,
  timeoutMs: number,
  execution?: CronAgentExecutionStarted,
  commandSettlement?: Promise<unknown>,
): Promise<void> {
  const cleanupPromise = state.deps.cleanupTimedOutAgentRun?.({ job, timeoutMs, execution });
  if (!cleanupPromise && !commandSettlement) {
    return;
  }
  const cleanup = cleanupPromise?.catch((err: unknown) => {
    state.deps.log.warn(
      { jobId: job.id, err: String(err) },
      "cron: timed-out agent cleanup failed",
    );
  });
  await raceWithTimeout(
    Promise.allSettled([cleanup, commandSettlement]),
    CRON_TIMEOUT_CLEANUP_GUARD_MS,
    () => undefined,
  );
}

function resolveCronAgentPreExecutionWatchdogMs(jobTimeoutMs: number): number {
  return Math.max(
    CRON_AGENT_PRE_EXECUTION_MIN_WATCHDOG_MS,
    Math.min(CRON_AGENT_PRE_EXECUTION_WATCHDOG_MS, Math.floor(jobTimeoutMs / 2)),
  );
}
