import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../../infra/errors.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import {
  CommandProcessCleanupError,
  createSanitizedCommandError,
} from "../../process/exec-result.js";
import {
  runUtf8CommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "../../process/exec.js";
import { parseOpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { withUpdateCommandExecutorChild } from "./update-command-executor.js";
import type { UpdateDoctorInput } from "./update-command-migrated-types.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

/** Inspect the same published --check contract consumed by candidate canary. */
export async function inspectUpdateDoctorChildSupport(
  argv: string[],
  options: CommandOptions,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  const workerPath = argv[1];
  if (!workerPath) {
    throw new UpdateCommandRecoveryPendingError("Target Doctor worker path is missing.");
  }
  try {
    await fs.lstat(workerPath);
  } catch (cause) {
    if (hasErrnoCode(cause, "ENOENT")) {
      // Candidate canary preserves this pre-worker published-target contract.
      // Only the expected worker's absence qualifies, never a failed command.
      assertCurrent();
      return false;
    }
    throw new UpdateCommandRecoveryPendingError("Target Doctor worker could not be inspected.", {
      cause,
    });
  }
  assertCurrent();
  let result: SpawnResult;
  try {
    result = await runUtf8CommandWithTimeout([...argv, "--check"], {
      ...options,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      maxOutputBytes: 64 * 1024,
      terminateOnOutputLimit: true,
    });
  } catch (cause) {
    throw new UpdateCommandRecoveryPendingError(
      "Target Doctor capability could not be inspected.",
      {
        cause,
      },
    );
  }
  assertCurrent();
  let contract: unknown;
  try {
    contract = JSON.parse(result.stdout);
  } catch {
    // A broken check is not evidence of an older, supported CLI contract.
  }
  if (
    result.code !== 0 ||
    result.termination !== "exit" ||
    result.cleanup !== "normal" ||
    result.outputLimitExceeded ||
    result.outputErrorStream ||
    !isRecord(contract) ||
    !parseOpenClawSchemaVersions(contract)
  ) {
    throw new UpdateCommandRecoveryPendingError("Target Doctor capability could not be inspected.");
  }
  const capability = contract.doctorConfigWrites;
  if (capability !== undefined && capability !== "pid-start-v1") {
    throw new UpdateCommandRecoveryPendingError("Target Doctor authority protocol is unsupported.");
  }
  // v2026.9.3 reports its schemas but has no delegated Doctor entrypoint.
  return capability === "pid-start-v1";
}

export type UpdateDoctorChildContext = {
  runId: string;
  executorFence: UpdateRecoveryFence;
  requester?: Readonly<UpdateRequester>;
  /** The parent mutation fence is suspended while its child owns effects. */
  assertRequesterCurrent: () => void;
};

/** Package and finalization Doctors use the same private-input/native-child owner. */
export async function withUpdateDoctorChild<T>(
  params: {
    root: string;
    context: UpdateDoctorChildContext;
    input: Omit<UpdateDoctorInput, "executor" | "runId" | "root" | "requester">;
  },
  operation: (
    runCommand: (argv: string[], options: CommandOptions) => Promise<SpawnResult>,
  ) => Promise<T>,
) {
  const { context } = params;
  context.assertRequesterCurrent();
  return await withUpdateCommandExecutorChild(
    context.executorFence,
    params.root,
    async (executor, bindChild) => {
      context.assertRequesterCurrent();
      const input: UpdateDoctorInput = {
        ...params.input,
        executor,
        runId: context.runId,
        root: params.root,
        requester: context.requester,
      };
      return await operation(async (argv, options) => {
        const result = await runUtf8CommandWithTimeout(argv, {
          ...options,
          input: JSON.stringify(input),
          beforeInput: (pid, spawnedArgv) => {
            context.assertRequesterCurrent();
            bindChild(pid, spawnedArgv);
          },
          killProcessTree: true,
          requireProcessTreeExtinction: true,
        });
        if (result.cleanup === "forced" || result.cleanup === "uncertain") {
          throw new CommandProcessCleanupError();
        }
        return result;
      });
    },
  );
}

/** Adapt the owned process result to the existing fresh-Doctor diagnostic contract. */
export function assertUpdateDoctorChildSucceeded(child: SpawnResult): void {
  if (
    child.code === 0 &&
    child.termination === "exit" &&
    !child.outputLimitExceeded &&
    !child.outputErrorStream
  ) {
    return;
  }
  const failure = {
    failed: true,
    ...(child.code !== null ? { exitCode: child.code } : {}),
    ...(child.signal ? { signal: child.signal } : {}),
    timedOut: child.termination === "timeout" || child.termination === "no-output-timeout",
    isCanceled: child.termination === "signal",
    isMaxBuffer: child.outputLimitExceeded === true,
    isTerminated: child.killed || Boolean(child.signal),
  };
  throw Object.assign(createSanitizedCommandError(failure), failure, {
    stdout: child.stdout,
    stderr: child.stderr,
  });
}
