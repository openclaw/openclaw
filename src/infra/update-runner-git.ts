import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import { isErrno } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import { readPackageVersion } from "./package-json.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import { DEV_BRANCH, type UpdateChannel } from "./update-channels.js";
import { getUpdateDoctorConfigFailureReason } from "./update-doctor-config.js";
import { createUpdateErrorFact } from "./update-failure-facts.js";
import {
  readBuiltGatewayBuildId,
  readBuiltRuntimeCommit,
  readGitRuntimeArtifactIdentity,
  verifyGitUpdateRecovery,
} from "./update-git-runtime.js";
import { UpdateRequesterRevokedError } from "./update-requester-authority.js";
import { isFailedUpdateStep } from "./update-run-step.js";
import { runStep } from "./update-runner-command.js";
import { gitCleanCheckArgs } from "./update-runner-git-commands.js";
import {
  readCurrentGitUpdateRecovery,
  recordGitRollbackOutcome,
} from "./update-runner-git-recovery.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";
import { createGitUpdateSteps } from "./update-runner-git-step-policy.js";
import { runGitCleanCheckStep, runGitUpstreamStep } from "./update-runner-git-steps.js";
import {
  fetchGitUpdateTarget,
  prepareGitMutation,
  readBranchName,
  selectGitInspectionTarget,
  withGitTargetInspectionRoot,
} from "./update-runner-git-target.js";
import { prepareGitCandidateTransfer } from "./update-runner-git-transfer.js";
import type { CommandRunner, UpdateRunResult, UpdateRunnerOptions } from "./update-runner-types.js";
import type { UpdateStepResult } from "./update-step-result.js";

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
  const [beforeVersion, beforeBuildId, beforeBuiltCommit] = await Promise.all([
    readPackageVersion(gitRoot),
    readBuiltGatewayBuildId(gitRoot),
    readBuiltRuntimeCommit(gitRoot),
  ]);
  const before = {
    sha: beforeSha,
    version: beforeVersion,
    ...(beforeBuildId ? { buildId: beforeBuildId } : {}),
  };
  const branch = await readBranchName(runCommand, gitRoot, timeoutMs);
  const devTarget = channel === "dev" ? opts.devTarget : undefined;
  const hasDevTarget = devTarget !== undefined;
  const activateBranch = channel === "dev" && !hasDevTarget;
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
  let runtimeRetained = false;
  let candidateTransfer:
    | Extract<Awaited<ReturnType<typeof prepareGitCandidateTransfer>>, { status: "ok" }>
    | undefined;
  let stateMigrationStarted = false;
  let cleanupUncertain = false;
  let recovery = await verifyGitUpdateRecovery({ root: gitRoot, sha: beforeSha });
  let rollbackOutcome: NonNullable<UpdateRunResult["rollbackOutcome"]> = {
    status: "not-needed",
    reason: "Installed checkout was not changed",
  };
  const prepareMutation = async (revision: string, root = gitRoot, runner = runCommand) => {
    // Remote transport can outlive the earlier service inspection. Recheck
    // its frozen contexts before checkout without repeating stop/preparation.
    await prepareGitMutation({
      runCommand: runner,
      root,
      revision,
      timeoutMs,
      beforeGitMutation: mutationPrepared ? opts.inspectGitTarget : opts.beforeGitMutation,
    });
    if (!mutationPrepared) {
      mutationPrepared = true;
      recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
    }
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
  const rollback = async (assertCurrent = () => {}) => {
    if (!beforeSha) {
      return false;
    }
    const execute = async (name: string, args: string[]) => {
      assertCurrent();
      const result = await runStep(recoveryStep(name, ["git", "-C", gitRoot, ...args], gitRoot));
      assertCurrent();
      return result;
    };
    const restore = async (name: string, args: string[]) =>
      !isFailedUpdateStep(await execute(name, args));
    let restored = await restore("git-rollback-clean", ["reset", "--hard"]);
    restored =
      (await restore("git-rollback-clean-untracked", [
        "clean",
        "-fd",
        "-e",
        "dist/control-ui/",
        ...(runtimePromotion?.sourceTreeStagingPaths.flatMap((relative) => [
          "-e",
          `/${relative}/`,
        ]) ?? []),
      ])) && restored;
    const attached = branch && branch !== "HEAD";
    const checkedOut = await restore(
      "git-rollback-checkout",
      attached ? ["checkout", "--force", branch] : ["checkout", "--detach", beforeSha],
    );
    if (attached && checkedOut) {
      restored = (await restore("git-rollback-reset", ["reset", "--hard", beforeSha])) && restored;
    }
    if (createdDevBranchDuringUpdate && (!attached || checkedOut)) {
      await restore("git-rollback-delete-branch", ["branch", "-D", DEV_BRANCH]);
    }
    const head = await execute("git-rollback-verify-head", ["rev-parse", "HEAD"]);
    const verified = !isFailedUpdateStep(head) && head.stdoutTail?.trim() === beforeSha;
    head.exitCode = verified ? 0 : 1;
    if (!verified) {
      head.stderrTail = `expected ${beforeSha}, found ${head.stdoutTail?.trim() || "unreadable HEAD"}`;
    }
    return restored && checkedOut && verified;
  };
  const restoreRuntime = async (assertCurrent = () => {}, runtimeSha = beforeSha) => {
    const sourceRestored = await rollback(assertCurrent);
    let runtimeRestored = true;
    try {
      await runtimePromotion?.restore(assertCurrent);
    } catch (error) {
      assertCurrent();
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
        : await verifyGitUpdateRecovery({ root: gitRoot, sha: runtimeSha });
    assertCurrent();
    const restored = sourceRestored && runtimeRestored && recovery.serviceRestartSafe;
    rollbackOutcome = {
      status: restored ? "succeeded" : "failed",
      reason: restored
        ? "Previous checkout and runtime restored and verified"
        : "Previous checkout or runtime restoration could not be verified",
    };
    return restored;
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
      await restoreRuntime();
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
    if (!isFailedUpdateStep(result)) {
      return null;
    }
    return mutationPrepared ? rollbackError(reason) : buildError(reason);
  };
  const { result: statusCheck, dirty } = await runGitCleanCheckStep(
    step("clean-check", gitCleanCheckArgs(gitRoot), gitRoot),
  );
  if (isFailedUpdateStep(statusCheck)) {
    return buildError(dirty ? "dirty" : "clean-check-failed");
  }
  if (activateBranch && branch !== DEV_BRANCH) {
    const devBranchRef = `refs/heads/${DEV_BRANCH}`;
    const branchCheckOptions = step(
      "git-activation-branch-check",
      ["git", "-C", gitRoot, "branch", "--force", DEV_BRANCH, devBranchRef],
      gitRoot,
    );
    const branchCheck = await runStep({
      ...branchCheckOptions,
      runCommand: async (argv, options) => {
        const exists = await runCommand(
          ["git", "-C", gitRoot, "show-ref", "--verify", "--quiet", devBranchRef],
          options,
        );
        if (exists.code === 1) {
          return { ...exists, code: 0, stdout: "", stderr: "" };
        }
        if (exists.code !== 0) {
          return {
            ...exists,
            stdout: "",
            stderr: `Could not inspect local branch ${DEV_BRANCH} before activation. Resolve the Git branch error, then rerun openclaw update.`,
          };
        }
        // Resetting a branch to its current ref is a ref/reflog no-op, but Git still
        // enforces every worktree owner state, including paused rebase and bisect.
        const result = await runCommand(argv, options);
        const sanitized = { ...result, stdout: "" };
        return result.code !== 0
          ? {
              ...sanitized,
              stderr:
                `Cannot activate this dev update because a Git worktree uses or reserves branch ${DEV_BRANCH}. ` +
                `Finish or abort its rebase or bisect, or move it off ${DEV_BRANCH}, then rerun openclaw update.`,
            }
          : sanitized;
      },
    });
    if (isFailedUpdateStep(branchCheck)) {
      return buildError("checkout-failed");
    }
  }
  const checkSourceUnchanged = async (expectedSha = beforeSha, expectedBranch = branch) => {
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
      currentHead.stdout.trim() !== expectedSha ||
      currentBranch !== expectedBranch ||
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
        const transfer = await prepareGitCandidateTransfer({
          candidateSha,
          beforeSha,
          installedRoot: gitRoot,
          installedRunCommand: runCommand,
          upstreamRef,
          step: inspectionWorkStep("git-pack-update", [], inspectionRoot),
          probeTimeoutMs: timeoutMs,
        });
        if (!transfer || transfer.status === "error") {
          return { status: "error" as const, reason: transfer?.reason ?? "fetch-failed" };
        }
        await using admittedTransfer = transfer;
        const sourceChanged = await checkSourceUnchanged();
        if (sourceChanged) {
          return sourceChanged;
        }
        await prepareMutation(candidateSha, inspectionRoot, runInspectionCommand);
        candidateTransfer = transfer;
        const imported = await admittedTransfer.importInto(
          workStep("git-import-admitted-target", [], gitRoot),
        );
        if (!imported) {
          return { status: "error" as const, reason: "fetch-failed" };
        }
        return { status: "ok" as const };
      };
      const fetched = await fetchGitUpdateTarget({
        root: inspectionRoot,
        step: inspectionStep,
        workStep: inspectionWorkStep,
        name: "git-target-inspection-fetch",
        channel,
        devTarget,
        steps,
      });
      if (!fetched.ok) {
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
        // Clone publication moves the repository, so its owner supplies stationary
        // artifact storage. Existing checkouts keep their durable staging and cache.
        artifactRoot: opts.gitArtifactStorageRoot ?? gitRoot,
        runCommand: runInspectionCommand,
        step: inspectionStep,
        workStep: inspectionWorkStep,
        workTimeoutMs: opts.timeoutMs,
        channel,
        devTarget,
        refreshedRemotes: fetched.refreshedRemotes,
        beforeSha,
        beforeBuiltCommit,
        sourceRuntimePrepared: opts.sourceRuntimePrepared,
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
          // Filesystem staging shares command steps' progress, heartbeat, and failure reporting.
          await runStep({
            ...inspectionWorkStep("preflight-runtime-stage", [], root),
            runCommand: async () => {
              runtimePromotion = await prepareGitRuntimePromotion(
                gitRoot,
                root,
                runInspectionCommand,
                timeoutMs,
                cleanupRoot,
              );
              return { code: 0, stdout: "", stderr: "" };
            },
          });
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
      if (preflight.status === "skipped" && preflight.reason === "already-current") {
        return {
          ...buildError(preflight.reason, preflight.status),
          sourceRuntimePrepared: opts.sourceRuntimePrepared,
        };
      }
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
      if (isFailedUpdateStep(upstreamStep)) {
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
      stateMigrationStarted = true;
      recovery = { serviceRestartSafe: false, reason: "state-migration-started" };
      const doctorSteps: UpdateStepResult[] = [];
      let doctorStep: UpdateStepResult | null;
      try {
        doctorStep = await opts.runGitDoctor(gitRoot, doctorSteps);
      } catch (error) {
        steps.push(...doctorSteps);
        throw error;
      }
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
        // The CLI returns null before any state writes when its entrypoint is missing.
        stateMigrationStarted = false;
        return await rollbackError("doctor-entry-missing");
      }
      if (isFailedUpdateStep(doctorStep)) {
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
    if (isFailedUpdateStep(afterShaStep)) {
      return await rollbackError("head-verification-failed");
    }
    if (afterShaStep.stdoutTail?.trim() !== preflight.candidateSha) {
      return await rollbackError("target-sha-mismatch");
    }
    const gitRuntime = await readGitRuntimeArtifactIdentity(gitRoot);
    if (opts.onTransaction) {
      const promotion = runtimePromotion;
      const activatedBranch = await readBranchName(runCommand, gitRoot, timeoutMs);
      const assertRollbackSafe = async () => {
        if (await checkSourceUnchanged(preflight.candidateSha, activatedBranch)) {
          throw new Error("Git checkout changed after activation; retained rollback was refused.");
        }
      };
      let restored: ReturnType<PackageUpdateTransaction["rollback"]> | undefined;
      let completed: Promise<UpdateStepResult | void> | undefined;
      const retention = (message: string, warning = false): UpdateStepResult => ({
        name: "git-runtime-backup-retention",
        command: "retain previous Git runtime",
        cwd: gitRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail: message,
        ...(warning ? { advisory: { kind: "recoverable-maintenance" as const, message } } : {}),
      });
      opts.onTransaction({
        backupRoot: promotion.backupRoot,
        assertRollbackSafe,
        rollback: (assertCurrent) => {
          assertCurrent();
          if (completed) {
            throw new Error("Git runtime backup retirement has already started.");
          }
          return (restored ??= (async () => {
            await assertRollbackSafe();
            assertCurrent();
            const verified = await restoreRuntime(assertCurrent, beforeBuiltCommit ?? beforeSha);
            return {
              name: "git-runtime-rollback",
              command: "restore previous Git runtime",
              cwd: gitRoot,
              durationMs: 0,
              exitCode: verified ? 0 : 1,
              activePackageRoot: gitRoot,
            };
          })());
        },
        complete: (outcome, assertCurrent) => {
          assertCurrent();
          return (completed ??= (async () => {
            if (!outcome.activationVerified && (await restored)?.exitCode !== 0) {
              return retention(
                `Git recovery is unverified; previous runtime retained at ${promotion.backupRoot}.`,
              );
            }
            try {
              await promotion.cleanup(assertCurrent);
            } catch (error) {
              assertCurrent();
              if (
                hasCommandProcessCleanupError(error) ||
                !(error instanceof AggregateError ? error.errors : [error]).every(isErrno)
              ) {
                throw error;
              }
              return retention(
                `Git verification succeeded; backup cleanup remains pending at ${promotion.backupRoot}: ${formatErrorMessage(error)}`,
                true,
              );
            }
            return undefined;
          })());
        },
      });
      runtimeRetained = true;
    }
    return {
      status: "ok",
      mode: "git",
      root: gitRoot,
      before,
      gitRuntime,
      sourceRuntimePrepared: true,
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
    cleanupUncertain = hasCommandProcessCleanupError(error);
    if (!mutationPrepared || cleanupUncertain) {
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
    ).catch((rollbackFailure: unknown) => {
      cleanupUncertain = hasCommandProcessCleanupError(rollbackFailure);
      throw rollbackFailure;
    });
  } finally {
    if (!cleanupUncertain) {
      await candidateTransfer?.cleanup(step("git-update-pack-cleanup", [], gitRoot));
      if (!runtimeRetained) {
        await runtimePromotion?.cleanup();
      }
    }
  }
}
