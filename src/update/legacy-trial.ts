import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { servingGitReleaseSlot } from "../infra/git-release-paths.js";
import { sendUpdateResultTelemetry } from "../infra/update-result-telemetry.js";
import { persistInterruptedUpdateObservationAsync } from "../infra/update-run-interruption-worker.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import { isUpdateRepairRun } from "../infra/update-run-record.js";
import { recordUpdateRunStepAsync } from "../infra/update-run-write.async.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import {
  legacyTrialReceipt,
  legacyTrialSchema,
  type LegacyTrial,
  type LegacyTrialReceipt,
} from "./legacy-trial-record.js";
import { resolvePrefix } from "./store.js";

async function readLegacyTrial(prefix: string) {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(prefix, "releases", ".trial"), "utf8"),
    );
    return legacyTrialSchema.safeParse(raw).data;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function matchesSelectedRelease(root: string, target: string, prefix: string) {
  const slot = servingGitReleaseSlot(prefix);
  const [running, selected, candidate, realPrefix] = await Promise.all(
    [root, slot, path.resolve(path.dirname(slot), target), prefix].map((entry) =>
      fs.realpath(entry).catch(() => undefined),
    ),
  );
  return Boolean(
    running &&
    realPrefix &&
    running === selected &&
    running === candidate &&
    running.startsWith(path.join(realPrefix, "releases") + path.sep),
  );
}

/** Called only inside the candidate daemon command's already-admitted executor grant. */
export async function prepareLegacyTrialRun(
  runId: string,
  root: string,
  assertCurrent: () => void,
  env = { ...process.env },
) {
  const prefix = resolvePrefix(env);
  const trial = await readLegacyTrial(prefix);
  if (
    !trial ||
    trial.version !== VERSION ||
    trial.buildId !== resolveRuntimeServiceBuildId() ||
    !(await matchesSelectedRelease(root, trial.target, prefix))
  ) {
    return;
  }
  const context = captureOpenClawStateWorkerContext({ env });
  const run = await getUpdateRunAsync(runId, { env, path: context.admission.databasePath });
  if (
    !run ||
    run.status !== "running" ||
    run.target.kind !== "git" ||
    isUpdateRepairRun(run) ||
    !["activating", "restarting", "verifying"].includes(run.phase)
  ) {
    return;
  }
  await recordUpdateRunStepAsync(
    runId,
    { step: legacyTrialReceipt(trial).step, status: "completed", endedAtMs: Date.now() },
    { context, env, assertCurrent, requireNoRecovery: true },
  );
}

export async function captureLegacyTrial(
  root: string | null,
  buildId: string | null,
): Promise<LegacyTrial | undefined> {
  if (!root || !buildId) {
    return undefined;
  }
  const prefix = resolvePrefix();
  const trial = await readLegacyTrial(prefix);
  if (
    !trial ||
    trial.attempts < 1 ||
    trial.version !== VERSION ||
    trial.buildId !== buildId ||
    !(await matchesSelectedRelease(root, trial.target, prefix))
  ) {
    return undefined;
  }
  return trial;
}

/** Core readiness ends only the legacy trial this Gateway actually runs, without opening history. */
export async function disarmLegacyTrial(
  root: string | null,
  buildId: string | null,
  captured?: LegacyTrial,
): Promise<LegacyTrialReceipt | undefined> {
  const trial = captured ?? (await captureLegacyTrial(root, buildId));
  if (!root || !trial || trial.buildId !== buildId) {
    return undefined;
  }
  const prefix = resolvePrefix();
  if (!(await matchesSelectedRelease(root, trial.target, prefix))) {
    return undefined;
  }
  const receipt = legacyTrialReceipt(trial);
  const current = await readLegacyTrial(prefix);
  if (current !== null && (!current || legacyTrialReceipt(current).step !== receipt.step)) {
    return undefined;
  }
  if (current) {
    await fs.rm(path.join(prefix, "releases", ".trial"), { force: true });
  }
  return receipt;
}

export async function recoverLegacyTrialRun(
  receipt: LegacyTrialReceipt,
  onCompleted: (runId: string) => void,
): Promise<boolean> {
  const context = captureOpenClawStateWorkerContext();
  const result = await persistInterruptedUpdateObservationAsync(context, {
    legacyReady: receipt,
    detail: "The selected legacy Git release is core-ready after its original updater exited.",
    verification: {
      runningVersion: receipt.version,
      runningBuildId: receipt.buildId,
      pid: process.pid,
      booted: true,
      serviceRunning: true,
      versionMatch: true,
      coreReady: true,
      settled: true,
    },
  });
  if (result?.updateResult) {
    void sendUpdateResultTelemetry(result.updateResult, { env: context.environment });
  }
  if (result?.run) {
    onCompleted(result.run.runId);
  }
  return result !== undefined && !result.retry;
}
