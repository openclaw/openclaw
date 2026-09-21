import { formatErrorMessage } from "../../infra/errors.js";
import { readActiveGatewayLockPort } from "../../infra/gateway-lock.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { createUpdateFailureFact } from "../../infra/update-failure-facts.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { getUpdateRun, recordUpdateRunDiagnostics } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";
import { appendPluginUpdateWarnings } from "./update-command-plugins-internals.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import {
  readManagedGatewayServiceForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import {
  readFailedUpdateGatewayState,
  verifyUpdatedGateway,
} from "./update-command-verification.js";

/** Observe recovery after writers settle; this never starts or stops a Gateway. */
export async function verifyUpdateFailureRecovery(params: {
  result: UpdateRunResult;
  root: string;
  opts: UpdateCommandOptions;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  serviceStopped?: boolean;
  assertCurrent?: () => void;
}): Promise<UpdateRunResult> {
  params.assertCurrent?.();
  const startedAt = Date.now();
  const result = params.result;
  const env = params.env ?? params.opts.run?.env ?? process.env;
  const root = params.root;
  const run = params.opts.run;
  const warnRecording = (message: string) => {
    params.assertCurrent?.();
    defaultRuntime.error(message);
    result.steps.push({
      name: "gateway recovery recording",
      command: "gateway verification",
      cwd: root,
      durationMs: 0,
      exitCode: 0,
      advisory: { kind: "recoverable-maintenance", message },
    });
  };
  let recorded: ReturnType<typeof getUpdateRun> | undefined;
  try {
    recorded = run ? getUpdateRun(run.runId, { env: run.env }) : undefined;
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    warnRecording(`Could not read update recovery history: ${formatErrorMessage(error)}`);
  }
  const constraint = recorded?.verification.recovery;
  const previousRecovery =
    constraint?.serviceRestartSafe === false
      ? constraint
      : (result.recovery ?? constraint ?? undefined);
  result.recovery = previousRecovery;
  result.rollbackOutcome ??= recorded?.verification.rollbackOutcome ?? undefined;
  result.verification = {};
  const rollback = previousRecovery?.packageRollbackVerified;
  try {
    await withCommandProcessScope(async () => {
      if (params.serviceStopped) {
        try {
          result.verification = {
            ...(await readFailedUpdateGatewayState(params.opts.run, env)),
            // Native process identity alone cannot reconfirm earlier readiness.
            versionMatch: undefined,
            readyz: false,
            settled: false,
            channelsReady: false,
          };
        } catch (error) {
          if (
            error instanceof UpdateCommandRecoveryPendingError ||
            hasCommandProcessCleanupError(error)
          ) {
            throw error;
          }
          params.assertCurrent?.();
          warnRecording(
            `Could not save Gateway recovery verification: ${formatErrorMessage(error)}`,
          );
        }
        params.assertCurrent?.();
      }
      const version = await readPackageVersion(root);
      if (!version) {
        throw new Error(
          "The installed Gateway version could not be read for recovery verification.",
        );
      }
      const buildId = await readBuiltGatewayBuildId(root);
      const gatewayPort =
        (await readActiveGatewayLockPort({ env, requireInspection: true })) ??
        (await resolveUpdatedGatewayRestartPort({
          serviceEnv: env,
          serviceCommand: (await readManagedGatewayServiceForUpdate(env))?.command,
        }));
      params.assertCurrent?.();
      const validation = await verifyUpdatedGateway({
        result,
        opts: params.opts,
        purpose: "recovery",
        serviceEnv: env,
        gatewayPort,
        expectedVersion: version,
        expectedBuildId: buildId ?? undefined,
        timeoutMs: params.timeoutMs,
        assertCurrent: params.assertCurrent,
      });
      params.assertCurrent?.();
      Object.assign(result, appendPluginUpdateWarnings(result, validation.pluginWarnings ?? []));
      // Observed health cannot override an owner's unsafe restart verdict.
      const restartUnsafe = previousRecovery?.serviceRestartSafe === false;
      result.recovery =
        validation.ok && !restartUnsafe
          ? {
              serviceRestartSafe: true,
              version,
              ...(buildId ? { buildId } : {}),
              ...(rollback ? { packageRollbackVerified: true } : {}),
              service: "healthy",
            }
          : previousRecovery?.serviceRestartSafe
            ? {
                ...previousRecovery,
                service: validation.stopReason ? undefined : "failed",
                reason: validation.stopReason ?? validation.summary,
              }
            : (previousRecovery ?? {
                serviceRestartSafe: false,
                reason: "runtime-verification-failed",
              });
    });
  } catch (error) {
    if (
      error instanceof UpdateCommandRecoveryPendingError ||
      hasCommandProcessCleanupError(error)
    ) {
      throw error;
    }
    params.assertCurrent?.();
    const probeFailureStep: UpdateStepResult = {
      name: "gateway recovery verification",
      command: "gateway verification",
      cwd: root,
      durationMs: Math.max(0, Date.now() - startedAt),
      exitCode: 1,
      failureFacts: [
        createUpdateFailureFact({
          check: "gateway-recovery",
          code: "gateway-probe-failed",
          message: formatErrorMessage(error),
        }),
      ],
    };
    const previousStep = result.steps.findIndex((step) => step.name === probeFailureStep.name);
    if (previousStep === -1) {
      result.steps.push(probeFailureStep);
    } else {
      result.steps[previousStep] = probeFailureStep;
    }
    result.recovery = previousRecovery?.serviceRestartSafe
      ? { ...previousRecovery, service: undefined, reason: "gateway-probe-failed" }
      : (previousRecovery ?? { serviceRestartSafe: false, reason: "runtime-verification-failed" });
  }
  if (run) {
    params.assertCurrent?.();
    const saved = recordUpdateRunDiagnostics(
      run.runId,
      () => {
        params.assertCurrent?.();
        return result;
      },
      warnRecording,
      { env: run.env },
    );
    // Unread history may still prohibit restart until the atomic merge confirms it.
    result.recovery =
      saved?.verification.recovery ??
      (!recorded && result.recovery?.serviceRestartSafe ? undefined : result.recovery);
  }
  return result;
}
