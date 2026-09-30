import fs from "node:fs";
import {
  finishInterruptedUpdateBeforeActivation,
  getUpdateRun,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "../signal-exit-barrier.js";
import type { UpdateCommandOptions } from "./shared.js";

type Run = NonNullable<UpdateCommandOptions["run"]>;
// Only the object minted by this local admission participates. A saved run ID,
// inherited diagnostic row, or a recovered process identity cannot populate it.
const admissions = new WeakMap<
  Run,
  {
    record: UpdateRunRecord;
    env: NodeJS.ProcessEnv;
    dev: number;
    ino: number;
    active?: true;
    unconfirmedWrite?: { error: unknown };
  }
>();

/** Record uncertainty before signal gates release the original admission to its finalizer. */
export function retainMutableUpdateSignalWrite(
  run: Run | undefined,
  completion: Promise<void>,
): void {
  const admission = run ? admissions.get(run) : undefined;
  const retained = completion.catch((error: unknown) => {
    if (!hasCommandProcessCleanupError(error)) {
      return;
    }
    if (admission) {
      admission.unconfirmedWrite ??= { error };
    }
    throw error;
  });
  const release = registerSignalExitGate(retained);
  void retained.then(release, release);
}

export function admitMutableUpdateSignalRun(run: Run, record: UpdateRunRecord): void {
  const env = { ...run.env };
  const file = fs.lstatSync(resolveOpenClawStateSqlitePath(env));
  if (!file.isFile()) {
    throw new Error("Update admission requires its regular state database.");
  }
  admissions.set(run, { record, env, dev: file.dev, ino: file.ino });
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
        throw new Error("Interrupted update's canonical state generation changed.");
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
  const unregister = registerSignalExitBarrier(async () => {
    try {
      settle?.();
    } catch {
      defaultRuntime.error("Update interruption could not be recorded; history remains pending.");
    }
  });
  const onSignal = (code: number) => {
    if (shutdown) {
      return;
    }
    run.interrupted = true;
    // Freeze custody before yielding; the executor stays held through signal settlement.
    try {
      settle = prepareSettlement();
    } catch {
      defaultRuntime.error("Update interruption could not be recorded; history remains pending.");
    }
    shutdown = waitForSignalExitBarriers()
      .catch(() => {
        defaultRuntime.error("Update signal cleanup did not complete.");
      })
      .finally(() => process.exit(code));
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  try {
    return await operation();
  } finally {
    await shutdown;
    retireMutableUpdateSignalRun(run);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    unregister();
  }
}
