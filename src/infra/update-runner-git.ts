import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import { readPackageVersion } from "./package-json.js";
import { DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
import { getUpdateDoctorConfigFailureReason } from "./update-doctor-config.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import { readBuiltGatewayBuildId, verifyGitUpdateRecovery } from "./update-git-runtime.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { runStep } from "./update-runner-command.js";
import { gitCleanCheckArgs } from "./update-runner-git-commands.js";
import {
  readCurrentGitUpdateRecovery,
  recordGitRollbackOutcome,
} from "./update-runner-git-recovery.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";
import { createGitUpdateSteps } from "./update-runner-git-step-policy.js";
import {
  resolveGitDoctorEntry,
  runGitCleanCheckStep,
  runGitUpstreamStep,
} from "./update-runner-git-steps.js";
import {
  fetchGitUpdateTarget,
  prepareGitMutation,
  readBranchName,
  selectGitInspectionTarget,
  withGitTargetInspectionRoot,
} from "./update-runner-git-target.js";
import { prepareGitCandidateTransfer } from "./update-runner-git-transfer.js";
import type {
  CommandRunner,
  UpdateRunResult,
  UpdateRunnerOptions,
  UpdateStepResult,
} from "./update-runner-types.js";

export async function updateGitCheckout(params: {
  opts: UpdateRunnerOptions;
  gitRoot: string;
  runCommand: CommandRunner;
  defaultCommandEnv: NodeJS.ProcessEnv | undefined;
  timeoutMs: number;
  startedAt: number;
}): Promise<UpdateRunResult> {
  const { opts, defaultCommandEnv, timeoutMs, startedAt } = params;
  let gitRoot = params.gitRoot;
  const runCommand: CommandRunner = (argv, options) =>
    params.runCommand(argv, {
      ...options,
      // Read-only status must not refresh the installed index before admission.
      ...(argv[0] === "git" ? { env: { ...options.env, GIT_OPTIONAL_LOCKS: "0" } } : {}),
    });
  const channel: UpdateChannel = opts.channel ?? "dev";
  if (channel === "extended-stable") {
    return {
      status: "error",
      mode: "git",
      root: gitRoot,
      reason: "unsupported_git_channel",
      recovery: await readCurrentGitUpdateRecovery(gitRoot, timeoutMs),
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeShaResult = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
    cwd: gitRoot,
    timeoutMs,
  });
  const beforeSha = beforeShaResult.stdout.trim() || null;
  const [beforeVersion, beforeBuildId] = await Promise.all([
    readPackageVersion(gitRoot),
    readBuiltGatewayBuildId(gitRoot),
  ]);
  const before = {
    sha: beforeSha,
    version: beforeVersion,
    ...(beforeBuildId ? { buildId: beforeBuildId } : {}),
  };
  const branch = await readBranchName(runCommand, gitRoot, timeoutMs);
  const devTarget = channel === "dev" ? opts.devTarget : undefined;
  const hasDevTarget = devTarget !== undefined;
  const needsCheckoutMain = channel === "dev" && !hasDevTarget && branch !== DEV_BRANCH;
  const totalSteps = channel === "dev" ? (needsCheckoutMain ? 12 : 11) : 9;
  const steps: UpdateStepResult[] = [];
  const { step, workStep, forRunner, recoveryStep } = createGitUpdateSteps({
    runCommand,
    opts,
    probeTimeoutMs: timeoutMs,
    totalSteps,
    results: steps,
  });

  let createdDevBranchDuringUpdate = false;
  let mutationPrepared = false;
  let sourceMutationStarted = false;
  let runtimePromotion: Awaited<ReturnType<typeof prepareGitRuntimePromotion>> | undefined;
  let candidateTransfer: Awaited<ReturnType<typeof prepareGitCandidateTransfer>>;
  let stateMigrationStarted = false;
  let recovery = await verifyGitUpdateRecovery({ root: gitRoot, sha: beforeSha });
  let rollbackOutcome: NonNullable<UpdateRunResult["rollbackOutcome"]> = {
    status: "not-needed",
    reason: "Installed checkout was not changed",
  };
  const prepareMutation = async (revision: string, root = gitRoot, runner = runCommand) => {
    if (mutationPrepared) {
      // Remote transport can outlive the earlier service inspection. Recheck
      // its frozen contexts before checkout without repeating stop/preparation.
      await prepareGitMutation({
        runCommand: runner,
        root,
        revision,
        timeoutMs,
        beforeGitMutation: opts.inspectGitTarget,
      });
      return;
    }
    await prepareGitMutation({
      runCommand: runner,
      root,
      revision,
      timeoutMs,
      beforeGitMutation: opts.beforeGitMutation,
    });
    mutationPrepared = true;
    recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
  };
  const buildError = (reason: string, status: "error" | "skipped" = "error"): UpdateRunResult => ({
    status,
    mode: "git",
    root: gitRoot,
    reason,
    before,
    recovery,
    rollbackOutcome,
    steps,
    durationMs: Date.now() - startedAt,
  });
  const appendRecoveryStep = async (name: string, argv: string[]) => {
    const result = await runStep(recoveryStep(name, argv, gitRoot));
    return result.exitCode === 0;
  };
  const verifyRollbackHead = async () => {
    if (!beforeSha) {
      return false;
    }
    const result = await runStep({
      runCommand,
      name: "git-rollback-verify-head",
      argv: ["git", "-C", gitRoot, "rev-parse", "HEAD"],
      cwd: gitRoot,
      timeoutMs,
      stepIndex: 0,
      totalSteps: 1,
      results: steps,
    });
    const verified = result.exitCode === 0 && result.stdoutTail?.trim() === beforeSha;
    result.exitCode = verified ? 0 : 1;
    if (!verified) {
      result.stderrTail = `expected ${beforeSha}, found ${result.stdoutTail?.trim() || "unreadable HEAD"}`;
    }
    return verified;
  };
  const rollback = async () => {
    if (!beforeSha) {
      return false;
    }
    let restored = await appendRecoveryStep("git-rollback-clean", [
      "git",
      "-C",
      gitRoot,
      "reset",
      "--hard",
    ]);
    // Preflight requires a clean checkout outside generated Control UI assets,
    // so preserve that excluded directory while removing update-created paths.
    restored =
      (await appendRecoveryStep("git-rollback-clean-untracked", [
        "git",
        "-C",
        gitRoot,
        "clean",
        "-fd",
        "-e",
        "dist/control-ui/",
        ...(runtimePromotion?.sourceTreeStagingPaths.flatMap((relative) => [
          "-e",
          `/${relative}/`,
        ]) ?? []),
      ])) && restored;
    if (branch && branch !== "HEAD") {
      const checkedOut = await appendRecoveryStep("git-rollback-checkout", [
        "git",
        "-C",
        gitRoot,
        "checkout",
        "--force",
        branch,
      ]);
      if (checkedOut) {
        restored =
          (await appendRecoveryStep("git-rollback-reset", [
            "git",
            "-C",
            gitRoot,
            "reset",
            "--hard",
            beforeSha,
          ])) && restored;
        if (createdDevBranchDuringUpdate) {
          await appendRecoveryStep("git-rollback-delete-branch", [
            "git",
            "-C",
            gitRoot,
            "branch",
            "-D",
            DEV_BRANCH,
          ]);
        }
      }
      const verified = await verifyRollbackHead();
      return restored && checkedOut && verified;
    }
    restored =
      (await appendRecoveryStep("git-rollback-checkout", [
        "git",
        "-C",
        gitRoot,
        "checkout",
        "--detach",
        beforeSha,
      ])) && restored;
    if (createdDevBranchDuringUpdate) {
      await appendRecoveryStep("git-rollback-delete-branch", [
        "git",
        "-C",
        gitRoot,
        "branch",
        "-D",
        DEV_BRANCH,
      ]);
    }
    const verified = await verifyRollbackHead();
    return restored && verified;
  };
  const rollbackError = async (reason: string) => {
    try {
      // Admission can stop the service before import changes any source or runtime.
      // Reverify retained artifacts without resetting an untouched checkout.
      if (!sourceMutationStarted) {
        if (!(await checkSourceUnchanged())) {
          recovery = await verifyGitUpdateRecovery({ root: gitRoot, sha: beforeSha });
        }
        return buildError(reason);
      }
      // Doctor can migrate state before failing. Restoring code cannot undo that boundary.
      if (stateMigrationStarted) {
        rollbackOutcome = {
          status: "not-attempted",
          reason: "State migration started; restoring code alone cannot restore operator state",
        };
        return buildError(reason);
      }
      const sourceRestored = await rollback();
      let runtimeRestored = true;
      try {
        await runtimePromotion?.restore();
      } catch (error) {
        runtimeRestored = false;
        steps.push({
          name: "git-runtime-rollback",
          command: "restore previous runtime",
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: String(error),
        });
      }
      recovery = !sourceRestored
        ? { serviceRestartSafe: false, reason: "source-rollback-failed" }
        : !runtimeRestored
          ? { serviceRestartSafe: false, reason: "runtime-verification-failed" }
          : await verifyGitUpdateRecovery({ root: gitRoot, sha: beforeSha });
      const restored = sourceRestored && runtimeRestored && recovery.serviceRestartSafe;
      rollbackOutcome = {
        status: restored ? "succeeded" : "failed",
        reason: restored
          ? "Previous checkout and runtime restored and verified"
          : "Previous checkout or runtime restoration could not be verified",
      };
      return buildError(reason);
    } catch (error) {
      if (sourceMutationStarted && !stateMigrationStarted) {
        rollbackOutcome = {
          status: "failed",
          reason: "Rollback threw before restoration could be verified",
        };
      }
      throw error;
    } finally {
      recordGitRollbackOutcome({
        outcome: rollbackOutcome,
        progress: opts.progress,
        root: gitRoot,
        steps,
      });
    }
  };
  const runRequiredStep = async (name: string, argv: string[], reason: string) => {
    const result = await runStep(workStep(name, argv, gitRoot));
    if (result.exitCode === 0) {
      return null;
    }
    return mutationPrepared ? rollbackError(reason) : buildError(reason);
  };
  const { result: statusCheck, dirty } = await runGitCleanCheckStep(
    step("clean-check", gitCleanCheckArgs(gitRoot), gitRoot),
  );
  if (statusCheck.exitCode !== 0) {
    return buildError(dirty ? "dirty" : "clean-check-failed");
  }
  const checkSourceUnchanged = async () => {
    const currentHead = await runCommand(["git", "-C", gitRoot, "rev-parse", "HEAD"], {
      cwd: gitRoot,
      timeoutMs,
    });
    const currentStatus = await runCommand(
      gitCleanCheckArgs(gitRoot, runtimePromotion?.sourceTreeStagingPaths),
      { cwd: gitRoot, timeoutMs },
    );
    if (currentHead.code !== 0 || currentStatus.code !== 0) {
      return { status: "error" as const, reason: "clean-check-failed" as const };
    }
    const currentBranch = await readBranchName(runCommand, gitRoot, timeoutMs);
    if (
      currentHead.stdout.trim() !== beforeSha ||
      currentBranch !== branch ||
      currentStatus.stdout.trim()
    ) {
      return { status: "error" as const, reason: "dirty" as const };
    }
    return undefined;
  };

  try {
    const inspectAndPrepare = async (
      inspectionRoot: string,
      runInspectionCommand: CommandRunner,
    ) => {
      let publishedCandidate = false;
      const { step: inspectionStep, workStep: inspectionWorkStep } =
        forRunner(runInspectionCommand);
      const importCandidate = async (candidateSha: string, upstreamRef?: string) => {
        // Close the pinned pack on every exit, including admission refusal,
        // before the surrounding inspection checkout is removed.
        await using transfer = await prepareGitCandidateTransfer({
          candidateSha,
          beforeSha,
          installedRoot: gitRoot,
          installedRunCommand: runCommand,
          upstreamRef,
          step: inspectionWorkStep("git-pack-update", [], inspectionRoot),
          probeTimeoutMs: timeoutMs,
        });
        if (!transfer) {
          return { status: "error" as const, reason: "fetch-failed" };
        }
        const sourceChanged = await checkSourceUnchanged();
        if (sourceChanged) {
          return sourceChanged;
        }
        await prepareMutation(candidateSha, inspectionRoot, runInspectionCommand);
        candidateTransfer = transfer;
        const imported = await transfer.importInto(
          workStep("git-import-admitted-target", [], gitRoot),
        );
        if (!imported) {
          return { status: "error" as const, reason: "fetch-failed" };
        }
        return { status: "ok" as const };
      };
      if (
        !(await fetchGitUpdateTarget({
          root: inspectionRoot,
          step: inspectionStep,
          workStep: inspectionWorkStep,
          name: "git-target-inspection-fetch",
          channel,
          steps,
        }))
      ) {
        return { status: "error" as const, reason: "fetch-failed" };
      }
      const inspectTarget = async (revision: string, root = inspectionRoot) => {
        await prepareGitMutation({
          runCommand: runInspectionCommand,
          root,
          revision,
          timeoutMs,
          beforeGitMutation: opts.inspectGitTarget,
        });
      };
      const selected = await selectGitInspectionTarget({
        gitRoot: inspectionRoot,
        runCommand: runInspectionCommand,
        step: inspectionStep,
        workStep: inspectionWorkStep,
        workTimeoutMs: opts.timeoutMs,
        channel,
        devTarget,
        beforeSha,
        beforeGitStaging: opts.beforeGitStaging,
        needsCheckoutMain,
        timeoutMs,
        defaultCommandEnv,
        steps,
        beforeCandidate: inspectTarget,
        validateCandidate: opts.validateCandidate,
        prepareGitExposure: opts.prepareGitExposure,
        prepareCandidate: async (root, cleanupRoot) => {
          const candidate = await runInspectionCommand(["git", "-C", root, "rev-parse", "HEAD"], {
            cwd: root,
            timeoutMs,
          });
          if (candidate.code !== 0 || !candidate.stdout.trim()) {
            throw new Error("Cannot inspect the validated Git update");
          }
          await inspectTarget(candidate.stdout.trim(), root);
          if (opts.publishGitCheckout) {
            // A new checkout must settle its destination before runtime relocation
            // records absolute paths. Candidate build/validation has already finished.
            if ((await importCandidate(candidate.stdout.trim())).status !== "ok") {
              throw new Error("Cannot import the admitted Git update");
            }
            gitRoot = await opts.publishGitCheckout();
            publishedCandidate = true;
          }
          runtimePromotion = await prepareGitRuntimePromotion(
            gitRoot,
            root,
            runInspectionCommand,
            timeoutMs,
            cleanupRoot,
          );
        },
      });
      if (selected.status !== "ok") {
        return selected;
      }
      if (!publishedCandidate) {
        const upstreamRef = selected.selectedDevUpstream
          ? `refs/remotes/${selected.selectedDevUpstream}`
          : undefined;
        const imported = await importCandidate(selected.candidateSha, upstreamRef);
        if (imported.status !== "ok") {
          return imported;
        }
      }
      return selected;
    };
    const preflight = await withGitTargetInspectionRoot(
      {
        root: gitRoot,
        runCommand,
        timeoutMs,
        work: { timeoutMs: opts.timeoutMs },
        onWarning: (warning) => {
          steps.push(warning);
          opts.progress?.onStepComplete?.({ ...warning, index: 0, total: 0 });
        },
      },
      inspectAndPrepare,
    );
    if (preflight.status !== "ok") {
      return mutationPrepared
        ? await rollbackError(preflight.reason)
        : buildError(preflight.reason, preflight.status);
    }
    // Candidate validation and cleanup attempts finish while the old gateway serves.
    // Its exact build is retained on this filesystem; activation never installs or builds.
    const sourceChanged = await checkSourceUnchanged();
    if (sourceChanged) {
      return buildError(sourceChanged.reason, sourceChanged.status);
    }
    await prepareMutation(preflight.candidateSha);
    const activateBranch = channel === "dev" && !hasDevTarget;
    sourceMutationStarted = true;
    const failure = await runRequiredStep(
      "git-checkout",
      activateBranch
        ? ["git", "-C", gitRoot, "checkout", "-B", DEV_BRANCH, preflight.candidateSha]
        : ["git", "-C", gitRoot, "checkout", "--detach", preflight.candidateSha],
      "checkout-failed",
    );
    if (failure) {
      return failure;
    }
    createdDevBranchDuringUpdate = activateBranch && preflight.localDevBranchExists === false;
    if (createdDevBranchDuringUpdate && preflight.selectedDevUpstream) {
      const upstreamArgs = [
        "git",
        "-C",
        gitRoot,
        "branch",
        "--set-upstream-to",
        preflight.selectedDevUpstream,
        DEV_BRANCH,
      ];
      const upstreamOptions = workStep("git-set-upstream", upstreamArgs, gitRoot);
      const upstreamStep = await runGitUpstreamStep(upstreamOptions);
      if (upstreamStep.exitCode !== 0 && !upstreamStep.advisory) {
        return await rollbackError("checkout-failed");
      }
    }
    if (!runtimePromotion) {
      return await rollbackError("runtime-verification-failed");
    }
    try {
      await runtimePromotion.activate();
    } catch (error) {
      steps.push({
        name: "git-runtime-activation",
        command: "activate validated runtime",
        cwd: gitRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: String(error),
      });
      return await rollbackError("runtime-verification-failed");
    }

    // Source conversion migrates only after its prepared global exposure is swapped.
    if (!opts.prepareGitExposure) {
      const doctorEntry = await resolveGitDoctorEntry(gitRoot, steps);
      if (!doctorEntry) {
        return await rollbackError("doctor-entry-missing");
      }
      stateMigrationStarted = true;
      recovery = { serviceRestartSafe: false, reason: "state-migration-started" };
      const doctorStep = await opts.runGitDoctor(gitRoot);
      steps.push(
        doctorStep ?? {
          name: "openclaw doctor",
          command: "run activation doctor",
          cwd: gitRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: "Required activation Doctor did not produce a result.",
        },
      );
      if (!doctorStep) {
        return await rollbackError("doctor-entry-missing");
      }
      if (doctorStep.exitCode !== 0 && !doctorStep.advisory) {
        return await rollbackError(
          getUpdateDoctorConfigFailureReason(doctorStep.configWriteRefusal) ?? "doctor-failed",
        );
      }
    }

    if ((await resolveControlUiAssetHealth({ root: gitRoot })).kind !== "ready") {
      steps.push({
        name: "ui-assets-verify",
        command: "verify startup assets",
        cwd: gitRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: "Control UI startup assets are missing or incomplete after Doctor",
      });
      return await rollbackError("ui-assets-missing");
    }
    const afterBuildId = await readBuiltGatewayBuildId(gitRoot);
    const afterShaStep = await runStep(
      step("git-verify-head", ["git", "-C", gitRoot, "rev-parse", "HEAD"], gitRoot),
    );
    if (afterShaStep.exitCode !== 0) {
      return await rollbackError("head-verification-failed");
    }
    if (afterShaStep.stdoutTail?.trim() !== preflight.candidateSha) {
      return await rollbackError("target-sha-mismatch");
    }
    return {
      status: "ok",
      mode: "git",
      root: gitRoot,
      before,
      after: {
        sha: afterShaStep.stdoutTail?.trim() ?? null,
        version: await readPackageVersion(gitRoot),
        ...(afterBuildId ? { buildId: afterBuildId } : {}),
        ...(devTarget?.mode === "tracked" ? { upstreamRef: devTarget.upstreamRef } : {}),
      },
      steps,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (!mutationPrepared) {
      throw error;
    }
    const fact = createUpdateErrorFact("git update", error, defaultCommandEnv);
    steps.push({
      name: "git-update",
      command: "update checkout",
      cwd: gitRoot,
      durationMs: 0,
      exitCode: 1,
      stderrTail: fact.message,
      failureFacts: [fact],
    });
    return await rollbackError(
      error instanceof UpdateRequesterRevokedError ? error.code : "unexpected-error",
    );
  } finally {
    await candidateTransfer?.cleanup(step("git-update-pack-cleanup", [], gitRoot));
    await runtimePromotion?.cleanup();
  }
}
