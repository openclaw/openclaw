import fs from "node:fs/promises";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { hasErrnoCode } from "../../infra/errors.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import {
  createUpdateDoctorProcessCustody,
  type UpdateDoctorProcessNamespace,
} from "../../infra/update-doctor-process-custody.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "../../infra/update-doctor-result.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import {
  CommandProcessCleanupError,
  createSanitizedCommandError,
  readCommandProcessFailure,
} from "../../process/exec-result.js";
import {
  resolveCommandEnv,
  runUtf8CommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "../../process/exec.js";
import { parseOpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
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
  // A broken check is not evidence of an older, supported CLI contract.
  const contract = safeParseJsonRecord(result.stdout);
  if (
    result.code !== 0 ||
    result.termination !== "exit" ||
    result.cleanup !== "normal" ||
    result.outputLimitExceeded ||
    result.outputErrorStream ||
    !contract ||
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
  onStateHandoff?: () => void;
  onProcessSettlement?: (step: UpdateStepResult) => void;
};

/** Both delegated and standalone update Doctors publish through the same result channel. */
export async function runUpdateDoctorProcess(
  context: {
    runId: string;
    root: string;
    processNamespace?: UpdateDoctorProcessNamespace;
    /** Only the delegated worker waits for the complete private grant before Doctor effects. */
    privateInputContract?: "delegated-doctor";
    onProcessSettlement?: (step: UpdateStepResult) => void;
  },
  argv: string[],
  options: CommandOptions,
): Promise<SpawnResult> {
  const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
  if (!resultPath) {
    throw new UpdateCommandRecoveryPendingError(
      "Doctor process custody requires its result channel.",
    );
  }
  const statePath = resolveOpenClawStateSqlitePath(resolveCommandEnv({ argv, ...options }));
  const custody = await createUpdateDoctorProcessCustody(
    context.runId,
    context.root,
    resultPath,
    context.processNamespace,
    context.privateInputContract,
  );
  try {
    let outcome: { result: SpawnResult } | { error: unknown };
    try {
      outcome = {
        result: await runUtf8CommandWithTimeout(argv, {
          ...options,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
        }),
      };
    } catch (error) {
      outcome = { error };
    }
    const settlement = await custody.settle(
      "result" in outcome ? outcome.result : readCommandProcessFailure(outcome.error),
    );
    if (settlement) {
      const error = new CommandProcessCleanupError(
        "error" in outcome ? { cause: outcome.error } : undefined,
      );
      error.message = settlement.stderrTail ?? "Doctor process settlement could not be recorded.";
      try {
        context.onProcessSettlement?.(settlement);
      } catch (cause) {
        if (settlement.exitCode !== 0) {
          throw new AggregateError([error, cause], error.message, { cause });
        }
        if ("error" in outcome) {
          throw new AggregateError([outcome.error, cause], "Doctor settlement recording failed", {
            cause,
          });
        }
        throw cause;
      }
      if (settlement.exitCode !== 0) {
        throw error;
      }
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.result;
  } finally {
    try {
      // Doctor can migrate in another process, outside this parent's admission publication cells.
      revokeSqliteDatabaseAdmissionsForPath(statePath);
    } finally {
      custody.close();
    }
  }
}

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
      return await operation((argv, options) =>
        runUpdateDoctorProcess(
          {
            ...context,
            root: params.root,
            privateInputContract: "delegated-doctor",
            processNamespace: {
              roots: [
                executor.childKey,
                ...(executor.originalChildKey ? [executor.originalChildKey] : []),
                ...(executor.retainedChildKey ? [executor.retainedChildKey] : []),
                ...(executor.slot ? [executor.slot.childKey] : []),
              ],
              databaseIdentity: executor.databaseIdentity,
            },
          },
          argv,
          {
            ...options,
            input: JSON.stringify(input),
            beforeInput: (pid, spawnedArgv) => {
              context.assertRequesterCurrent();
              bindChild(pid, spawnedArgv);
              // Only the bound target may read state-backed policy after migration.
              // The parent retains identity and native custody, never schema admission.
              context.onStateHandoff?.();
            },
          },
        ),
      );
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
