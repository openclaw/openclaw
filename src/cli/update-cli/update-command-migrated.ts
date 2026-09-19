import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
  updateStateSchemaVersionsMatch,
} from "../../infra/update-candidate-state.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import { isUpdateGatewayReadinessPending } from "../../infra/update-run-step.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { CLI_NAME } from "../cli-name.js";
import { resolveNodeRunner } from "./shared.js";
import {
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import type {
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
} from "./update-command-migrated-types.js";
import {
  createUpdateCommandFinalizationFence,
  UpdateCommandRecoveryPendingError,
} from "./update-command-recovery.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import {
  resolveUpdatedInstallCommandEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import { recordUpdatePackageCompletion } from "./update-command-terminal.js";

export type { MigratedUpdateFinalizationResult } from "./update-command-migrated-types.js";

/** Inspect private state copies without reopening migrated state through the previous runtime. */
export async function inspectActivatedUpdateState(
  params: Pick<
    FinishUpdateParams,
    "result" | "root" | "schemaVersions" | "packageUpdateNodeRunner"
  > & {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    candidateSchemaVersions?: OpenClawSchemaVersions;
    timeoutMs?: number;
  },
): Promise<FinishUpdateParams["rollbackBlockedReason"]> {
  const { result, root, schemaVersions, candidateSchemaVersions, env, config } = params;
  if (!schemaVersions) {
    return undefined;
  }
  try {
    const current = await readUpdateStateSchemaVersions({
      stateDir: resolveStateDir(env),
      config,
      env,
      root: result.root ?? null,
      nodeRunner: params.packageUpdateNodeRunner,
      timeoutMs: params.timeoutMs,
    });
    const shared = current.find((entry) => entry.path === resolveOpenClawStateSqlitePath(env));
    const sharedVersion = shared ? resolveUpdateStateContentVersion(shared) : undefined;
    if (
      result.status === "ok" &&
      candidateSchemaVersions &&
      sharedVersion !== candidateSchemaVersions.state
    ) {
      // Doctor can warn without failing. Require applied content so startup
      // cannot migrate late; deferred publication alone is already ready.
      result.status = "error";
      result.reason = `${CLI_NAME} doctor`;
      result.steps.push({
        name: `${CLI_NAME} doctor`,
        command: `${CLI_NAME} doctor --fix`,
        cwd: result.root ?? root,
        durationMs: 0,
        exitCode: 1,
        stderrTail: `Shared state migration did not finish: expected schema ${candidateSchemaVersions.state}, found ${sharedVersion ?? "missing"}.`,
      });
    }
    return updateStateSchemaVersionsMatch(schemaVersions, current, {
      sharedPath: resolveOpenClawStateSqlitePath(env),
      candidateSchemaVersions,
    })
      ? undefined
      : "state-migrated-no-rollback";
  } catch (error) {
    result.status = "error";
    result.reason = "rollback-state-unverified";
    result.steps.push({
      name: "state schema verification",
      command: "openclaw update",
      cwd: result.root ?? root,
      durationMs: 0,
      exitCode: 1,
      stderrTail: formatErrorMessage(error),
    });
    return "rollback-state-unverified";
  }
}

/** After migration, only candidate code may reopen state or finish the run. */
export async function continueMigratedUpdateInFreshProcess(
  params: FinishUpdateParams,
  bufferedSteps: UpdateRunStep[],
): Promise<Pick<MigratedUpdateFinalizationResult, "result" | "exitCode" | "automaticTriage">> {
  if (params.opts.recovery) {
    throw new UpdateCommandRecoveryPendingError("Full-state checkpoint recovery is deferred.");
  }
  const run = params.opts.run;
  if (!run) {
    throw new Error("Migrated update continuation requires its admitted run.");
  }
  const assertCurrent = createUpdateCommandFinalizationFence(params);
  assertCurrent();
  const windowsRecovery = params.preManagedServiceStop?.windowsTaskAutoStartRecovery;
  const result = params.result;
  const scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-migrated-"));
  try {
    const root = result.root;
    if (!root) {
      throw new Error("The active installation root is unknown; update finalization is unsafe.");
    }
    const workerCommand = [
      params.packageUpdateNodeRunner ?? resolveNodeRunner(),
      path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
    ];
    const workerEnv = {
      ...stripGatewayServiceMarkerEnv(
        resolveUpdatedInstallCommandEnv({
          processEnv: params.ownedManagedUpdateEnv ?? run.env,
        }),
      ),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      TMPDIR: scratchDir,
      TMP: scratchDir,
      TEMP: scratchDir,
    };
    if (run.executorFence || run.completionOwner) {
      assertCurrent();
      // Compatibility only, never authority. An older installed worker ignores
      // new JSON fields, so refuse before exposing any continuation input.
      const check = await runUtf8CommandWithTimeout([...workerCommand, "--check"], {
        cwd: root,
        baseEnv: {},
        env: workerEnv,
        timeoutMs: params.updateStepTimeoutMs,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        killGraceMs: 500,
        maxOutputBytes: 64 * 1024,
      });
      assertCurrent();
      let contract: unknown;
      try {
        contract = JSON.parse(check.stdout);
      } catch (cause) {
        throw new UpdateCommandRecoveryPendingError(
          "Update live executor delegation capability could not be inspected.",
          { cause },
        );
      }
      if (
        check.termination !== "exit" ||
        check.code !== 0 ||
        check.cleanup !== "normal" ||
        !isRecord(contract) ||
        (run.executorFence && contract.executorDelegation !== "pid-start-v1")
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Update runtime does not support live executor delegation; recovery remains pending.",
        );
      }
      if (run.completionOwner === "gateway-restart" && contract.gatewayRestartCompletion !== true) {
        throw new UpdateCommandRecoveryPendingError(
          "Candidate runtime cannot defer foreground update completion to Gateway restart; recovery remains pending.",
        );
      }
    }
    if (windowsRecovery && params.preManagedServiceStop) {
      // The parent retains its original definition-refresh grant for compensation.
      // Only the fresh finalizer may restore autostart at activation after migration.
      windowsRecovery.handoff(
        createWindowsTaskAutoStartGuard({
          root: result.root ?? params.root,
          before: params.preManagedServiceStop,
          timeoutMs: params.updateStepTimeoutMs,
        }),
      );
    }
    const { packageTransaction: _transaction, preManagedServiceStop, ...serializable } = params;
    let stopState: MigratedUpdateFinalizationInput["params"]["preManagedServiceStop"];
    if (preManagedServiceStop) {
      const { windowsTaskAutoStartRecovery: _windows, ...serializableStop } = preManagedServiceStop;
      stopState = serializableStop;
    }
    run.activationTimeoutMs ??= await resolveUpdateFinalizationTimeoutMs(
      params.updateStepTimeoutMs,
      {
        env: params.ownedManagedUpdateEnv ?? run.env,
        databases: params.schemaVersions,
        pluginCount: Object.keys(params.preUpdatePluginInstallRecords).length,
        nodeRunner: params.packageUpdateNodeRunner,
      },
    );
    assertCurrent();
    const resultPath = path.join(scratchDir, "result.json");
    const { requesterAuthority, executorFence, ...runIdentity } = run;
    const input: MigratedUpdateFinalizationInput = {
      params: {
        ...serializable,
        opts: {
          ...params.opts,
          run: {
            ...runIdentity,
            ...(requesterAuthority
              ? { requesterAuthority: { requester: requesterAuthority.requester } }
              : {}),
          },
        },
        rollbackBlockedReason: params.rollbackBlockedReason ?? "state-migrated-no-rollback",
        ...(preManagedServiceStop ? { preManagedServiceStop: stopState } : {}),
      },
      bufferedSteps,
      ...(windowsRecovery ? { windowsTaskAutoStartSuspended: true } : {}),
      resultPath,
    };
    const runChild = (
      grant?: UpdateCommandChildGrant,
      bindChild?: (pid: number, argv?: readonly string[]) => void,
    ) =>
      runUtf8CommandWithTimeout(workerCommand, {
        cwd: root,
        baseEnv: {},
        env: workerEnv,
        input: JSON.stringify({ ...input, ...(grant ? { executor: grant } : {}) }),
        beforeInput: bindChild,
        // This continuation includes bounded plugin steps as well as service
        // verification; the whole-process bound must exceed one step's budget.
        timeoutMs: run.activationTimeoutMs,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        killGraceMs: 500,
        maxOutputBytes: 1024 * 1024,
      });
    const child = executorFence
      ? await withUpdateCommandExecutorChild(executorFence, root, runChild)
      : await runChild();
    if (child.stdout) {
      process.stdout.write(child.stdout);
    }
    if (child.stderr) {
      process.stderr.write(child.stderr);
    }
    const response = JSON.parse(
      await fs.readFile(resultPath, "utf8"),
    ) as MigratedUpdateFinalizationResult; // SAFETY: Only the candidate worker launched above writes this private artifact.
    if (
      child.termination !== "exit" ||
      child.code !== 0 ||
      child.cleanup !== "normal" ||
      (executorFence && response.executorDelegation !== "pid-start-v1") ||
      (response.terminalRunId !== run.runId &&
        !(
          run.completionOwner === "gateway-restart" &&
          run.gatewayRestartRequired === true &&
          response.restartRunId === run.runId &&
          response.result.status === "ok"
        )) ||
      response.result.runId !== run.runId ||
      !Number.isInteger(response.exitCode)
    ) {
      throw new Error("Update finalization did not confirm the admitted run's terminal outcome.");
    }
    try {
      await windowsRecovery?.complete(
        response.result.status === "ok" || isUpdateGatewayReadinessPending(response.result),
      );
    } catch (cause) {
      throw new UpdateCommandFailure(
        response.result,
        response.exitCode || 1,
        `${response.result.reason ?? "Update failed"}; Windows task autostart compensation failed: ${formatErrorMessage(cause)}`,
        { cause },
      );
    }
    const cleanupFailure = await recordUpdatePackageCompletion(
      params,
      response.result,
      assertCurrent,
    );
    if (cleanupFailure) {
      throw cleanupFailure;
    }
    return {
      result: response.result,
      exitCode: response.exitCode,
      automaticTriage: response.automaticTriage,
    };
  } catch (error) {
    if (error instanceof UpdateCommandRecoveryPendingError) {
      // A refused compatibility/admission check is not delegated completion and
      // cannot authorize native restoration in the old, migrated runtime.
      throw error;
    }
    try {
      await windowsRecovery?.complete(false);
    } catch (cause) {
      throw new AggregateError(
        [error, cause],
        `Update finalization failed (${formatErrorMessage(error)}) and Windows task autostart compensation failed (${formatErrorMessage(cause)})`,
        { cause },
      );
    }
    throw error;
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}
