import fs from "node:fs";
import {
  finishInterruptedUpdateBeforeActivation,
  getUpdateRun,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../../infra/update-run-timeouts.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../../utils/absolute-deadline.js";
import {
  exitAfterSignalExitBarriers,
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "../signal-exit-barrier.js";
import type { UpdateCommandOptions } from "./shared.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;
type MutableAdmission = {
  record: UpdateRunRecord;
  env: NodeJS.ProcessEnv;
  dev: number;
  ino: number;
  active?: true;
  sealed?: true;
  settlements: Set<Promise<void>>;
  unconfirmedWrite?: { error: unknown };
  phase: UpdateRunRecord["phase"];
  terminal?: Promise<void>;
  recovering?: true;
  interruption?: { signal: "SIGINT" | "SIGTERM" | "SIGHUP"; phase: string; error: Error };
  forward: Set<() => void>;
};
// Only the object minted by this local admission participates. A saved run ID,
// inherited diagnostic row, or a recovered process identity cannot populate it.
const admissions = new WeakMap<Run, MutableAdmission>();

/** Exit must retain recovery through executor settlement and the bounded failure report. */
export async function withMutableUpdateTerminalSettlement<T>(
  operation: (retain: (run: Run) => void) => Promise<T>,
): Promise<T> {
  const completion = createDeferredCore();
  try {
    return await operation((run) => {
      const admission = admissions.get(run);
      if (admission) {
        admission.terminal = completion.promise;
      }
    });
  } finally {
    completion.resolve();
  }
}

export function recordMutableUpdateSignalPhase(
  run: Run | undefined,
  phase: UpdateRunRecord["phase"],
) {
  const admission = run && admissions.get(run);
  if (admission) {
    admission.phase = phase;
  }
}

/** Only forward commands inherit interruption; rollback retains its original live fence. */
export async function withMutableUpdateForwardScope<T>(
  opts: UpdateCommandOptions,
  work: () => Promise<T>,
): Promise<T> {
  const admission = opts.run && admissions.get(opts.run);
  if (!admission) {
    return await work();
  }
  if (admission.interruption) {
    throw admission.interruption.error;
  }
  return await withCommandProcessScope(async (stop) => {
    admission.forward.add(stop);
    try {
      return await work();
    } finally {
      admission.forward.delete(stop);
    }
  });
}

export function recordMutableUpdateInterruption(
  opts: UpdateCommandOptions,
  result: UpdateRunResult,
): UpdateRunResult {
  const interruption = opts.run && admissions.get(opts.run)?.interruption;
  if (
    !interruption ||
    result.steps.some(
      (step) =>
        step.name === interruption.phase &&
        step.termination === "signal" &&
        step.signal === interruption.signal &&
        step.stderrTail === interruption.error.message,
    )
  ) {
    return result;
  }
  const step = {
    name: interruption.phase,
    command: "openclaw update",
    cwd: result.root ?? "",
    durationMs: 0,
    exitCode: 1,
    termination: "signal" as const,
    signal: interruption.signal,
    stderrTail: interruption.error.message,
  };
  return {
    ...result,
    status: "error",
    reason: "interrupted",
    failedStep: step,
    steps: [...result.steps, step],
  };
}

function trackSignalSettlement(admission: MutableAdmission | undefined, completion: Promise<void>) {
  const retained = completion.catch((error: unknown) => {
    if (!hasCommandProcessCleanupError(error)) {
      return;
    }
    if (admission) {
      admission.unconfirmedWrite ??= { error };
    }
    throw error;
  });
  if (admission) {
    admission.settlements.add(retained);
    const release = () => admission.settlements.delete(retained);
    void retained.then(release, release);
  }
  return retained;
}

/** Record uncertainty before signal gates release the original admission to its finalizer. */
export function retainMutableUpdateSignalWrite(
  run: Run | undefined,
  completion: Promise<void>,
): void {
  const retained = trackSignalSettlement(run ? admissions.get(run) : undefined, completion);
  const release = registerSignalExitGate(retained);
  void retained.then(release, release);
}

/** Retain rollback work without retaining a potentially unbounded forward command. */
export function captureMutableUpdateCompensation(opts: UpdateCommandOptions) {
  const run = opts.run;
  const admission = run ? admissions.get(run) : undefined;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (!admission) {
      return await operation();
    }
    if (
      !run ||
      opts.run !== run ||
      admissions.get(run) !== admission ||
      run.runId !== admission.record.runId ||
      !admission.active ||
      admission.sealed
    ) {
      throw new Error("Update compensation admission is no longer current.");
    }
    const completion = createDeferredCore();
    // The admission owner joins this settlement after the compensation operation resolves.
    void trackSignalSettlement(admission, completion.promise);
    try {
      const result = await operation();
      completion.resolve();
      return result;
    } catch (error) {
      completion.reject(error);
      throw error;
    }
  };
}

export function admitMutableUpdateSignalRun(run: Run, record: UpdateRunRecord): void {
  const env = { ...run.env };
  const file = fs.lstatSync(resolveOpenClawStateSqlitePath(env));
  if (!file.isFile()) {
    throw new Error("Update admission requires its regular state database.");
  }
  admissions.set(run, {
    record,
    env,
    dev: file.dev,
    ino: file.ino,
    settlements: new Set(),
    phase: record.phase,
    forward: new Set(),
  });
}

export function retireMutableUpdateSignalRun(run: Run): void {
  admissions.delete(run);
}

export async function withMutableUpdateSignals<T>(
  opts: UpdateCommandOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const run = opts.run;
  const admission = !opts.dryRun && run ? admissions.get(run) : undefined;
  if (!run || !admission || admission.active) {
    return await operation();
  }
  admission.active = true;
  const { env } = admission;
  const pathname = resolveOpenClawStateSqlitePath(env);
  const prepareSettlement = () => {
    const { executorFence, runId } = run;
    if (
      admissions.get(run) !== admission ||
      process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" ||
      process.env.OPENCLAW_UPDATE_POST_CORE === "1" ||
      !executorFence
    ) {
      return undefined;
    }
    const assertCurrent = () => {
      if (
        opts.run !== run ||
        admissions.get(run) !== admission ||
        run.runId !== runId ||
        run.executorFence !== executorFence ||
        process.env.OPENCLAW_UPDATE_RUN_HANDOFF === "1" ||
        process.env.OPENCLAW_UPDATE_POST_CORE === "1"
      ) {
        throw new Error("Interrupted update has no live installation owner.");
      }
      executorFence.assertCurrent();
      const file = fs.lstatSync(pathname);
      if (!file.isFile() || file.dev !== admission.dev || file.ino !== admission.ino) {
        throw new Error("Interrupted update's current state generation changed.");
      }
    };
    assertCurrent();
    return () => {
      assertCurrent();
      if (admission.unconfirmedWrite) {
        throw admission.unconfirmedWrite.error;
      }
      const expected = getUpdateRun(runId, { env });
      if (
        !expected ||
        expected.status !== "running" ||
        !["requested", "staging", "validating"].includes(expected.phase) ||
        expected.createdAtMs !== admission.record.createdAtMs
      ) {
        return;
      }
      assertCurrent();
      // Accepted worker writes have settled; the original interruption policy owns this row.
      finishInterruptedUpdateBeforeActivation(expected, assertCurrent, { env });
    };
  };
  let settle: (() => void) | undefined;
  let shutdown: Promise<void> | undefined;
  let cleanup: Promise<void> | undefined;
  const finishOwnedCleanup = () => {
    admission.sealed = true;
    return (cleanup ??= (async () => {
      // Compensation may accept another write while draining. Keep this executor
      // until every locally admitted settlement completes, not the enclosing CLI gate.
      while (admission.settlements.size > 0) {
        await Promise.allSettled(admission.settlements);
      }
      try {
        settle?.();
      } catch {
        defaultRuntime.error("Update interruption could not be recorded; history remains pending.");
      }
      if (admission.unconfirmedWrite) {
        throw admission.unconfirmedWrite.error;
      }
    })());
  };
  const unregister = registerSignalExitBarrier(finishOwnedCleanup);
  const onSignal = (signal: "SIGINT" | "SIGTERM" | "SIGHUP", code: number) => {
    if (shutdown) {
      return;
    }
    if (admission.terminal && ["activating", "restarting", "verifying"].includes(admission.phase)) {
      admission.recovering = true;
      admission.interruption = {
        signal,
        phase: admission.phase,
        error: new Error(`Update interrupted by ${signal} during ${admission.phase}.`),
      };
      defaultRuntime.error(
        `${admission.interruption.error.message} Recovering the Gateway before exit. Check openclaw update status; use openclaw update repair if recovery remains pending.`,
      );
      const deadline =
        Date.now() +
        (run.activationTimeoutMs ?? run.defaultStepTimeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS);
      const settled = awaitWithinDeadline(() => admission.terminal!, deadline).then((result) => {
        if (result === ABSOLUTE_DEADLINE_EXPIRED) {
          defaultRuntime.error(
            "Update interruption cleanup exceeded its recovery budget. Run openclaw update status, then openclaw update repair to inspect retained recovery.",
          );
        }
      });
      const release = registerSignalExitGate(settled);
      void settled.then(release, release);
    } else {
      admission.sealed = true;
    }
    run.interrupted = true;
    for (const stop of admission.forward) {
      stop();
    }
    // Freeze custody before yielding; the executor stays held through signal settlement.
    try {
      if (!admission.recovering) {
        settle = prepareSettlement();
      }
    } catch {
      defaultRuntime.error("Update interruption could not be recorded; history remains pending.");
    }
    if (signal === "SIGHUP") {
      // The shared CLI signal type covers INT/TERM; retain HUP as the same
      // accepted process outcome instead of silently converting it to SIGINT.
      exitAfterSignalExitBarriers(code);
    }
    shutdown = waitForSignalExitBarriers(signal === "SIGHUP" ? undefined : signal)
      .catch(() => {
        defaultRuntime.error("Update signal cleanup did not complete.");
      })
      .finally(() => {
        process.exitCode = code;
      });
  };
  const onSigint = () => onSignal("SIGINT", 130);
  const onSigterm = () => onSignal("SIGTERM", 143);
  const onSighup = () => onSignal("SIGHUP", 129);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  let outcome: { result: T } | { error: unknown };
  try {
    outcome = { result: await operation() };
  } catch (error) {
    outcome = { error };
  }
  try {
    await finishOwnedCleanup();
  } catch (error) {
    defaultRuntime.error("Update signal cleanup did not complete.");
    outcome = {
      error:
        "error" in outcome && outcome.error !== error
          ? new AggregateError([outcome.error, error], "Update cleanup failed", {
              cause: outcome.error,
            })
          : error,
    };
  } finally {
    if (admission.recovering && admission.terminal) {
      // Publication outside this executor still needs the original interruption facts.
      // This retained record grants no new forward or compensation admission.
      void admission.terminal.then(() => retireMutableUpdateSignalRun(run));
    } else {
      retireMutableUpdateSignalRun(run);
    }
    const removeSignalHandlers = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("SIGHUP", onSighup);
    };
    // Repeated signals stay with the accepted drain after lexical custody closes.
    if (shutdown) {
      void shutdown.then(removeSignalHandlers, removeSignalHandlers);
    } else {
      removeSignalHandlers();
    }
    unregister();
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.result;
}
