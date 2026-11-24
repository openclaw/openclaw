import fs from "node:fs/promises";
import path from "node:path";
import { createGatewayRestartDeadline } from "../cli/daemon-cli/restart-health-deadline.js";
import { INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS } from "../cli/daemon-cli/restart-health.constants.js";
import { hasErrnoCode } from "../infra/errno.js";
import { sendUpdateResultTelemetry } from "../infra/update-result-telemetry.js";
import { observeInterruptedUpdateGateway } from "../infra/update-run-interruption-health.js";
import { persistInterruptedUpdateObservationAsync } from "../infra/update-run-interruption-worker.js";
import { getUpdateRunAsync, listUpdateRunsAsync } from "../infra/update-run-reader.js";
import { isUpdateRepairRun, type UpdateRunRecord } from "../infra/update-run-record.js";
import { recordUpdateRunStepAsync } from "../infra/update-run-write.async.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveRuntimeServiceBuildId, VERSION } from "../version.js";
import {
  LEGACY_TRIAL_PREPARED,
  LEGACY_TRIAL_READY,
  legacyTrialSchema,
  projectLegacyTrialReceipt,
  recoverableLegacyTrial,
  sameLegacyTrial,
} from "./legacy-trial-record.js";
import { resolvePrefix } from "./store.js";

async function readLegacyTrial(prefix: string) {
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(prefix, "releases", ".trial"), "utf8"),
    );
    return legacyTrialSchema.safeParse(raw).data;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT") || error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

async function matchesSelectedRelease(root: string, target: string, prefix: string) {
  const [running, selected, candidate, realPrefix] = await Promise.all(
    [root, path.join(prefix, "openclaw"), path.resolve(prefix, target), prefix].map((entry) =>
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
  context = captureOpenClawStateWorkerContext(),
) {
  const options = { env: context.environment, path: context.admission.databasePath };
  const run = await getUpdateRunAsync(runId, options);
  if (
    !run ||
    run.status !== "running" ||
    run.target.kind !== "git" ||
    isUpdateRepairRun(run) ||
    !["activating", "restarting", "verifying"].includes(run.phase)
  ) {
    return;
  }
  const prefix = resolvePrefix(context.environment);
  const trial = await readLegacyTrial(prefix);
  if (
    !trial ||
    trial.version !== VERSION ||
    trial.buildId !== resolveRuntimeServiceBuildId() ||
    !(await matchesSelectedRelease(root, trial.target, prefix))
  ) {
    return;
  }
  assertCurrent();
  await recordUpdateRunStepAsync(
    runId,
    {
      step: LEGACY_TRIAL_PREPARED,
      status: "completed",
      endedAtMs: Date.now(),
      detail: JSON.stringify(projectLegacyTrialReceipt(trial)),
    },
    { context, env: context.environment, assertCurrent, requireNoRecovery: true },
  );
}

/** Readiness ends only the legacy trial this Gateway actually runs, never a modern trial. */
export async function settleLegacyTrial(
  root: string | null,
  buildId: string | null,
  onCompleted: (runId: string) => void,
): Promise<boolean> {
  if (!root || !buildId) {
    return false;
  }
  const context = captureOpenClawStateWorkerContext();
  const options = { env: context.environment, path: context.admission.databasePath };
  const prefix = resolvePrefix(context.environment);
  const trial = await readLegacyTrial(prefix);
  if (
    !trial ||
    trial.attempts < 1 ||
    trial.version !== VERSION ||
    trial.buildId !== buildId ||
    !(await matchesSelectedRelease(root, trial.target, prefix))
  ) {
    return false;
  }
  // Match the exact publication occurrence, not a newest run or a version. Missing or
  // ambiguous history still ends the healthy trial, but cannot invent update success.
  const detail = JSON.stringify(projectLegacyTrialReceipt(trial));
  const matches = await listUpdateRunsAsync(
    {
      limit: 2,
      completedStep: { step: LEGACY_TRIAL_PREPARED, detail },
    },
    options,
  );
  if (matches.length === 1) {
    const recorded = await recordUpdateRunStepAsync(
      matches[0]!.runId,
      {
        step: LEGACY_TRIAL_READY,
        status: "completed",
        endedAtMs: Date.now(),
        detail,
      },
      { context, env: context.environment, requireNoRecovery: true },
    );
    if (!recorded) {
      return false;
    }
    const candidate = recoverableLegacyTrial(recorded);
    if (candidate) {
      const result = await persistInterruptedUpdateObservationAsync(context, {
        expected: recorded,
        legacyReady: true,
        detail: "The selected legacy Git release is core-ready after its original updater exited.",
        verification: {
          runningVersion: VERSION,
          runningBuildId: buildId,
          pid: process.pid,
          booted: true,
          serviceRunning: true,
          versionMatch: true,
          coreReady: true,
          settled: true,
        },
      });
      if (!result?.accepted) {
        return false;
      }
      if (result.updateResult) {
        void sendUpdateResultTelemetry(result.updateResult, { env: context.environment });
      }
      onCompleted(recorded.runId);
    } else if (recorded.status === "running") {
      // A live or unproven original driver retains completion; readiness can retry later.
      return false;
    }
  }
  // A later publication owns its own trial. The existing publisher serializes updates;
  // a change during these awaited history writes leaves settlement for the next tick.
  const current = await readLegacyTrial(prefix);
  if (current && sameLegacyTrial(current, trial)) {
    await fs.rm(path.join(prefix, "releases", ".trial"), { force: true });
    return true;
  }
  return false;
}

/** Explicit repair has finished maintenance; re-observe serving identity before history correction. */
export async function completeLegacyTrialRepair(
  expected: UpdateRunRecord,
  repairRunId: string,
  root: string,
): Promise<boolean> {
  const candidate = recoverableLegacyTrial(expected);
  if (!candidate || !(await matchesSelectedRelease(root, candidate.target, resolvePrefix()))) {
    return false;
  }
  const context = captureOpenClawStateWorkerContext({ env: process.env });
  const deadline = createGatewayRestartDeadline({
    timeoutMs: INTERRUPTED_UPDATE_SETTLE_TIMEOUT_MS,
  });
  try {
    const observation = await deadline.run(() =>
      observeInterruptedUpdateGateway(candidate, { deadline }),
    );
    if (
      !observation.verification ||
      deadline.cleanupStatus === "unknown" ||
      deadline.cleanupStatus === "pending"
    ) {
      return false;
    }
    const result = await persistInterruptedUpdateObservationAsync(context, {
      expected,
      legacyRepairRunId: repairRunId,
      verification: observation.verification,
      detail:
        "Legacy Git release verified after explicit repair completed Doctor and plugin maintenance.",
    });
    if (result?.accepted && result.updateResult) {
      void sendUpdateResultTelemetry(result.updateResult);
    }
    return result?.accepted === true;
  } finally {
    deadline.dispose();
  }
}
