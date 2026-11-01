import { DistArtifactOwnershipBusyError } from "../../../scripts/lib/dist-artifact-lock.mts";
import { inspectSourceUpdateArtifacts } from "../../../scripts/lib/source-update-artifact-preflight.mts";
import { formatErrorMessage } from "../../infra/errors.js";
import { reportUpdateStepCompletion } from "../../infra/update-runner-command.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { resolveCommandProcessSignal } from "../../process/exec-spawn.js";
import {
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { withMutableUpdateForwardScope } from "./update-command-mutable-signals.js";

/** Candidate work never writes the checkout, so a live builder only delays activation. */
const SOURCE_ARTIFACT_EARLY_WAIT_MS = 60_000;

type SourceArtifactAdmission = {
  waitMs: number;
  /** Report the holder and continue without ownership instead of ending the update. */
  deferIfHeld?: boolean;
  onWarning: (message: string) => void | Promise<void>;
};

export async function admitSourceUpdateArtifacts(
  root: string,
  run: UpdateCommandOptions["run"],
  admission: SourceArtifactAdmission,
): Promise<{ sourceRuntimePrepared: boolean; deferred: boolean }> {
  const signal = resolveCommandProcessSignal();
  try {
    const warnings: string[] = [];
    const prepared = await inspectSourceUpdateArtifacts(root, {
      waitMs: admission.waitMs,
      signal,
      onRecovered: (message) => warnings.push(message),
    });
    if (prepared.lock && !run) {
      await prepared.lock.release();
      throw new Error("Source artifact admission requires an active update run.");
    }
    if (run) {
      run.sourceArtifactLock = prepared.lock;
    }
    for (const warning of warnings) {
      await admission.onWarning(warning);
    }
    return { sourceRuntimePrepared: prepared.sourceRuntimePrepared, deferred: false };
  } catch (cause) {
    if (signal?.aborted && cause === signal.reason) {
      throw cause;
    }
    if (cause instanceof DistArtifactOwnershipBusyError && admission.deferIfHeld) {
      await admission.onWarning(
        `${cause.message} The update keeps preparing its candidate privately and takes ownership again before stopping the Gateway.`,
      );
      // Runtime completion would need the ownership this run does not hold.
      return { sourceRuntimePrepared: true, deferred: true };
    }
    throw new UpdatePreMutationError(
      "source-artifact-ownership",
      cause instanceof DistArtifactOwnershipBusyError
        ? `${cause.message} The current version keeps serving; the next update run continues from here.`
        : formatErrorMessage(cause),
      { cause },
    );
  }
}

/** One update run's checkout ownership, including the route around a live holder. */
export function createSourceArtifactOwnership(
  params: Pick<MutableUpdateExecutionParams, "opts" | "progress" | "root" | "switchToGit">,
  steps: UpdateStepResult[],
  lateWaitMs: number,
) {
  // Package-to-Git conversions have no checkout to own until their clone is published.
  const root = params.switchToGit ? resolveGitInstallDir() : params.root;
  const { run } = params.opts;
  let late = params.switchToGit;
  const onWarning = async (message: string) => {
    const step: UpdateStepResult = {
      name: "source-artifact-ownership",
      command: "admit checkout artifact ownership",
      cwd: root,
      durationMs: 0,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message },
    };
    steps.push(step);
    await reportUpdateStepCompletion(params.progress, { ...step, index: 0, total: 0 });
  };
  return {
    async admitEarly(): Promise<boolean> {
      // This wait starts outside the runner's command scope, and a signal must end it.
      const admitted = await withMutableUpdateForwardScope(params.opts, () =>
        admitSourceUpdateArtifacts(root, run, {
          waitMs: Math.min(SOURCE_ARTIFACT_EARLY_WAIT_MS, lateWaitMs),
          deferIfHeld: true,
          onWarning,
        }),
      );
      late ||= admitted.deferred;
      return admitted.sourceRuntimePrepared;
    },
    /** The Gateway keeps serving until this settles; activation is what needs ownership. */
    async admitBeforeActivation(): Promise<boolean> {
      if (!late || run?.sourceArtifactLock) {
        return false;
      }
      await admitSourceUpdateArtifacts(root, run, { waitMs: lateWaitMs, onWarning });
      return true;
    },
  };
}
