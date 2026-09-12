import fs from "node:fs/promises";
import { finishUpdateRun } from "../cli/daemon-cli.js";
import { retainCliProcessJobUntilExit, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import {
  withDelegatedUpdateCommandExecutor,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import type {
  UpdateDoctorInput,
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
} from "../cli/update-cli/update-command-migrated-types.js";
import { finishUpdate } from "../cli/update-cli/update-command-post-update.js";
import {
  formatUpdateFinalizationError,
  UpdateCommandFailure,
} from "../cli/update-cli/update-command-result.js";
import { createWindowsTaskAutoStartGuard } from "../cli/update-cli/update-command-service-maintenance.js";
import { createWindowsTaskAutoStartRecovery } from "../cli/update-cli/update-command-windows-task.js";
import { defaultRuntime } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveEnvironmentValue } from "./process-env.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  recordUpdateDoctorConfigWriteRefusal,
  writeUpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
import {
  createManagedUpdateRequesterAuthority,
  UpdateRequesterRevokedError,
} from "./update-requester-authority.js";
import { adoptUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

async function finalizeMigratedUpdate(): Promise<void> {
  // Validation imports this whole candidate graph before activation. The helper
  // also needs the stable recovery barrel's writer after an actual schema bump.
  if (process.argv[2] === "--check") {
    if (typeof finishUpdateRun !== "function") {
      throw new Error("Update recovery writer is unavailable.");
    }
    process.stdout.write(
      JSON.stringify({
        executorDelegation: "pid-start-v1",
        doctorConfigWrites: "pid-start-v1",
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      }),
    );
    return;
  }
  // The normal CLI bootstrap retains this native Job. This executable worker
  // bypasses that bootstrap, so install the same kill-on-close owner before input.
  // POSIX callers own the detached process group and join its kernel extinction.
  await withCliProcessScope(retainCliProcessJobUntilExit);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (process.argv[2] === "--doctor") {
    // SAFETY: The typed parent sends this private input only after binding this child.
    return await runDelegatedDoctor(JSON.parse(text) as UpdateDoctorInput);
  }
  // SAFETY: Only the typed parent continuation serializes this private input.
  const input = JSON.parse(text) as MigratedUpdateFinalizationInput;
  if (input.recoveryHandoff) {
    throw new Error(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
  }
  if (input.executor) {
    await withDelegatedUpdateCommandExecutor(
      input.executor,
      input.params.opts.run?.runId ?? "",
      input.params.result.root ?? input.params.root,
      async (fence) => finalizeInput(input, fence),
    );
  } else {
    // The shipped v2026.9.3 producer overrides these selectors for worker
    // scratch, but retains its pre-override environment in the private input.
    // Restore only this one-shot worker's selectors before resolving the normal
    // installation lease domain; scratch-local ownership cannot exclude updates.
    const admissionEnv = input.params.ownedManagedUpdateEnv ?? input.params.opts.run?.env;
    if (!admissionEnv) {
      throw new Error("Grantless finalization requires its captured update environment.");
    }
    for (const name of ["TMPDIR", "TMP", "TEMP"] as const) {
      const value = resolveEnvironmentValue(admissionEnv, name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    // Acquire before adopting the run or making effects. Missing newer grants
    // still cannot bypass a live original or descendant in that same domain.
    await withUpdateCommandExecutor(input.params.opts.run?.runId ?? "", async (executor) => {
      const fence = await executor.enter(input.params.result.root ?? input.params.root);
      await finalizeInput(input, fence);
    });
  }
}

async function runDelegatedDoctor(input: UpdateDoctorInput): Promise<void> {
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
  if (!resultPath || !input.executor) {
    throw new Error("Update Doctor requires its delegated executor and result path.");
  }
  await withDelegatedUpdateCommandExecutor(
    input.executor,
    input.runId,
    input.root,
    async (fence) => {
      const requester = input.requester
        ? await createManagedUpdateRequesterAuthority(input.requester)
        : undefined;
      const { runDoctorHealthFlow } = await import("../flows/doctor-health.js");
      const assertCurrent = () => {
        try {
          fence.assertCurrent();
          if (requester?.isCurrent() === false) {
            throw new UpdateRequesterRevokedError();
          }
        } catch (error) {
          recordUpdateDoctorConfigWriteRefusal({
            reason:
              error instanceof UpdateRequesterRevokedError ? error.code : "authority-check-failed",
            message: formatUpdateFinalizationError(error),
            keys: [],
          });
          throw error;
        }
      };
      try {
        assertCurrent();
      } catch (error) {
        if (!(error instanceof UpdateRequesterRevokedError)) {
          throw error;
        }
        fence.assertCurrent();
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: {
            status: "error",
            configWriteRefusal: { reason: error.code, message: error.message, keys: [] },
          },
        });
        process.exitCode = 1;
        return;
      }
      await runDoctorHealthFlow(
        {
          ...defaultRuntime,
          exit: (code) => {
            process.exitCode = code;
          },
        },
        { repair: input.repair, nonInteractive: true },
        { inputHash: input.configInputHash, assertCurrent },
      );
    },
  );
}

async function finalizeInput(
  input: MigratedUpdateFinalizationInput,
  executorFence?: UpdateRecoveryFence,
): Promise<void> {
  const transferredRun = input.params.opts.run;
  if (
    !transferredRun ||
    "executorFence" in transferredRun ||
    (!input.recoveryHandoff &&
      input.params.rollbackBlockedReason !== "state-migrated-no-rollback" &&
      input.params.rollbackBlockedReason !== "rollback-state-unverified")
  ) {
    throw new Error("Update finalization requires its migrated update run.");
  }
  const { requesterAuthority: descriptor, ...runIdentity } = transferredRun;
  executorFence?.assertCurrent();
  adoptUpdateRun(runIdentity.runId, { env: runIdentity.env });
  // Parent closures cannot cross JSON. Only the fresh installed runtime rebinds
  // the captured requester to the same current installation policy.
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    ...runIdentity,
    ...(executorFence ? { executorFence } : {}),
    ...(descriptor
      ? {
          requesterAuthority: await createManagedUpdateRequesterAuthority(
            descriptor.requester,
            runIdentity.env,
          ),
        }
      : {}),
  };
  executorFence?.assertCurrent();
  for (const step of input.bufferedSteps) {
    executorFence?.assertCurrent();
    recordUpdateRunStep(run.runId, step, { env: run.env });
  }
  const stopped = input.params.preManagedServiceStop;
  if (input.windowsTaskAutoStartSuspended && !stopped?.serviceEnv) {
    throw new Error("Transferred Windows task suspension is missing its stopped service owner.");
  }
  const windowsRecovery =
    input.windowsTaskAutoStartSuspended && stopped?.serviceEnv
      ? createWindowsTaskAutoStartRecovery({
          serviceEnv: stopped.serviceEnv,
          updateRun: run,
          alreadySuspended: true,
          assertCurrentService: createWindowsTaskAutoStartGuard({
            root: input.params.result.root ?? input.params.root,
            before: stopped,
            timeoutMs: input.params.updateStepTimeoutMs,
          }),
          assertCurrent: () => {
            run.executorFence?.assertCurrent();
            if (getUpdateRun(run.runId, { env: run.env })?.status !== "running") {
              throw new Error("Update run no longer owns Windows task activation.");
            }
          },
        })
      : undefined;
  let result;
  let exitCode = 0;
  let automaticTriage: MigratedUpdateFinalizationResult["automaticTriage"];
  try {
    result = await finishUpdate({
      ...input.params,
      opts: { ...input.params.opts, run },
      ...(stopped
        ? { preManagedServiceStop: { ...stopped, windowsTaskAutoStartRecovery: windowsRecovery } }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof UpdateCommandFailure)) {
      throw error;
    }
    result = error.result;
    exitCode = error.exitCode;
    automaticTriage = error.automaticTriage;
  } finally {
    await windowsRecovery?.complete(result?.status === "ok");
  }
  executorFence?.assertCurrent();
  const terminal = getUpdateRun(run.runId, { env: run.env });
  if (!terminal || terminal.status === "running") {
    throw new Error("Update finalization left the update run nonterminal.");
  }
  const response: MigratedUpdateFinalizationResult = {
    result,
    exitCode,
    terminalRunId: terminal.runId,
    ...(executorFence ? { executorDelegation: "pid-start-v1" as const } : {}),
    automaticTriage,
  };
  executorFence?.assertCurrent();
  await fs.writeFile(input.resultPath, JSON.stringify(response), { mode: 0o600 });
  executorFence?.assertCurrent();
}

void finalizeMigratedUpdate()
  .catch((error: unknown) => {
    process.stderr.write(`${formatUpdateFinalizationError(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeOpenClawStateDatabase());
