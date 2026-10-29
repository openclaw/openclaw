import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "./errno.js";
import { resolveNpmGlobalPrefixLayoutFromPrefix } from "./update-npm-prefix.js";
import { inspectUpdateRunAbandonment, recordedUpdateRunDrivers } from "./update-run-activity.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { sameUpdateRunDriver } from "./update-run-driver.js";
import { recordUpdateRunMutationAsync } from "./update-run-mutation.async.js";
import { getUpdateRunAsync } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";

/** Save cleanup custody before npm or candidate validation can be killed. */
export async function recordManagedUpdatePackageStage(
  stage: { prefix: string; packageRoot: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const runId = env.OPENCLAW_UPDATE_RUN_ID;
  if (!runId || env.OPENCLAW_UPDATE_RUN_HANDOFF !== "1") {
    return;
  }
  const run = await getUpdateRunAsync(runId, { env });
  if (!run?.origin.managedHandoff || run.status !== "running") {
    return;
  }
  const { dev, ino, birthtimeMs } = await fs.lstat(stage.prefix);
  await recordUpdateRunMutationAsync(
    runId,
    (input) => ({
      type: "updateRuns.recordPhase",
      input: {
        ...input,
        phase: run.phase,
        patch: {
          origin: { packageStage: { ...stage, identity: { dev, ino, birthtimeMs } } },
        },
      },
    }),
    { env },
  );
}

/** Only disposable, never-activated npm stages belong to orphan cleanup. */
export async function cleanupTerminatedHandoffStage(
  run: UpdateRunRecord,
  options: UpdateRunLedgerOptions,
): Promise<void> {
  const stage = run.origin.packageStage;
  if (
    !stage ||
    run.reason !== "handoff-terminated" ||
    run.steps.some(({ step }) =>
      ["repairing", "activating", "restarting", "verifying"].includes(step),
    )
  ) {
    return;
  }
  try {
    // Recheck live drivers after the ledger transaction, before filesystem effects.
    if (inspectUpdateRunAbandonment({ ...run, status: "running" }) !== "handoff-terminated") {
      return;
    }
    const stat = await fs.lstat(stage.prefix).catch(ignoreMissingPath);
    if (!stat) {
      return;
    }
    if (
      !stat.isDirectory() ||
      stat.dev !== stage.identity.dev ||
      stat.ino !== stage.identity.ino ||
      stat.birthtimeMs !== stage.identity.birthtimeMs ||
      (await fs.realpath(stage.prefix)) !== stage.prefix ||
      !path.basename(stage.prefix).startsWith(".openclaw.update-stage-")
    ) {
      throw new Error("The recorded package stage identity changed; it was retained.");
    }
    const layout = resolveNpmGlobalPrefixLayoutFromPrefix(stage.prefix);
    if (path.dirname(stage.packageRoot) !== layout.globalRoot) {
      throw new Error("The recorded package stage layout changed; it was retained.");
    }
    const { inspectOtherOpenClawProcesses } = await import("./openclaw-process-census.js");
    const census = inspectOtherOpenClawProcesses({
      runId: run.runId,
      artifactPaths: [stage.prefix],
      artifactPathsOnly: true,
      drivers: recordedUpdateRunDrivers(run).filter(
        (driver) =>
          !run.origin.managedHandoff ||
          !sameUpdateRunDriver(driver, run.origin.managedHandoff.parent),
      ),
      windowsUserSid: run.origin.windowsUserSid,
    });
    if (census.error || census.matchingPids.length || census.unverifiedPids.length) {
      throw new Error("Package stage work remains alive or unverified; it was retained.");
    }
    const { discardPackageUpdateStage } = await import("./package-update-stage-cleanup.js");
    const failure = await discardPackageUpdateStage({
      committed: false,
      stage: {
        ...stage,
        layout,
        installTarget: {
          manager: "npm",
          command: "npm",
          globalRoot: layout.globalRoot,
          packageRoot: stage.packageRoot,
        },
      },
    });
    if (failure) {
      throw new Error(failure.stderrTail ?? "Package stage cleanup failed");
    }
  } catch (error) {
    await recordUpdateRunMutationAsync(
      run.runId,
      (input) => ({
        type: "updateRuns.recordStep",
        input: {
          ...input,
          step: {
            step: "warning:recovery-artifact-cleanup",
            status: "completed",
            detail: String(error),
            endedAtMs: Date.now(),
          },
        },
      }),
      options,
    );
  }
}
