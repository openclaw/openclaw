import { formatErrorMessage } from "../../infra/errors.js";
import { readActiveGatewayLockPort } from "../../infra/gateway-lock.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { createUpdateFailureFact } from "../../infra/update-failure-facts.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { getUpdateRun, recordUpdateRunDiagnostics } from "../../infra/update-run-ledger.js";
import { isUpdatePostInstallVerificationDeferred } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import type { UpdateCommandOptions } from "./shared.js";
import { appendPluginUpdateWarnings } from "./update-command-plugins-internals.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import type {
  ManagedGatewayUpdateVerdict,
  PreManagedServiceStop,
  UpdateServiceDefinitionRecovery,
} from "./update-command-service-context-types.js";
import {
  readManagedGatewayServiceForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service-recovery.js";
import {
  readFailedUpdateGatewayState,
  verifyUpdatedGateway,
} from "./update-command-verification.js";

/** Restore an owned stopped service after writers settle, then verify its installed runtime. */
export async function verifyUpdateFailureRecovery(params: {
  result: UpdateRunResult;
  root: string;
  opts: UpdateCommandOptions;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  mutationStarted?: boolean;
  serviceStopped?: boolean;
  gatewayStartAttempted?: "install" | "restart";
  definitionRecovery?: UpdateServiceDefinitionRecovery;
  serviceUpdateVerdict?: ManagedGatewayUpdateVerdict;
  preManagedServiceStop?: PreManagedServiceStop;
  onGatewayStartAttempted?: () => void;
  nodeRunner?: string;
  invocationCwd?: string;
  waitForStartup?: boolean;
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
  const assertRecoveryFailureCurrent = (error: unknown) => {
    if (
      error instanceof UpdateCommandRecoveryPendingError ||
      hasCommandProcessCleanupError(error)
    ) {
      throw error;
    }
    params.assertCurrent?.();
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
  const dataAtRisk = [constraint, result.recovery].find(
    (recovery) => recovery?.serviceRestartSafe === false && recovery.dataAtRisk,
  );
  const previousRecovery =
    dataAtRisk ??
    (constraint?.serviceRestartSafe === false
      ? constraint
      : (result.recovery ?? constraint ?? undefined));
  result.recovery = previousRecovery;
  result.rollbackOutcome ??= recorded?.verification.rollbackOutcome ?? undefined;
  result.verification = {};
  const rollback = previousRecovery?.packageRollbackVerified;
  let restartAttempted = false;
  try {
    await withCommandProcessScope(async () => {
      const untouched =
        ((params.mutationStarted === false && !dataAtRisk) ||
          ["managed-service-preflight", "gateway-stop-unverified"].includes(result.reason ?? "")) &&
        !params.serviceStopped &&
        !params.preManagedServiceStop?.stopped &&
        !params.gatewayStartAttempted &&
        !params.definitionRecovery?.backup &&
        !params.definitionRecovery?.unverified;
      // An untouched refusal or absent service has no restart to recover.
      if (untouched || params.serviceUpdateVerdict?.kind === "absent") {
        result.steps.push({
          name: "gateway recovery observation",
          command: "gateway verification",
          cwd: root,
          durationMs: 0,
          exitCode: 0,
          diagnostics: [
            untouched
              ? `No recovery needed; ${params.preManagedServiceStop?.running ? "still serving" : "installation unchanged at"} ${result.before?.version ?? recorded?.before.version ?? "the previous version"}. No service was stopped or started.`
              : "Gateway readiness was not checked: no Gateway service or listener was present before maintenance.",
          ],
        });
        return;
      }
      if (
        params.opts.restart === false &&
        !params.serviceStopped &&
        result.steps.some(isUpdatePostInstallVerificationDeferred)
      ) {
        result.steps.push({
          name: "gateway recovery verification",
          command: "gateway verification",
          cwd: root,
          durationMs: 0,
          exitCode: null,
          advisory: {
            kind: "recoverable-maintenance",
            message:
              "Gateway recovery verification deferred because --no-restart leaves activation to the operator. Resolve the recorded update failure before restarting the Gateway through its service owner, then run openclaw update status and openclaw doctor.",
          },
        });
        return;
      }
      if (params.serviceStopped) {
        try {
          result.verification = {
            ...(await readFailedUpdateGatewayState(params.opts.run, env)),
            // Native process identity alone cannot reconfirm earlier readiness.
            versionMatch: undefined,
            readyz: false,
            coreReady: false,
            settled: false,
            channelsReady: false,
          };
        } catch (error) {
          assertRecoveryFailureCurrent(error);
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
      if (
        // An unverified installer receipt does not prove a start; never repeat a restart.
        params.gatewayStartAttempted !== "restart" &&
        (!params.gatewayStartAttempted || params.definitionRecovery?.unverified) &&
        params.opts.restart !== false &&
        params.preManagedServiceStop?.stopped &&
        params.preManagedServiceStop.serviceMutationAllowed !== false &&
        params.preManagedServiceStop.serviceUpdateVerdict?.kind === "owned" &&
        result.verification?.serviceRunning === false &&
        !(previousRecovery?.serviceRestartSafe === false && previousRecovery.dataAtRisk)
      ) {
        restartAttempted =
          (await maybeRestartServiceAfterFailedMutableUpdate({
            ...params,
            preManagedServiceStop: params.preManagedServiceStop,
            updateRun: run,
            recovery: { serviceRestartSafe: true, version, ...(buildId ? { buildId } : {}) },
            jsonMode: Boolean(params.opts.json),
            finalRecovery: true,
          })) === "healthy";
        params.assertCurrent?.();
      }
      const validation = await verifyUpdatedGateway({
        result,
        opts: params.opts,
        purpose: "recovery",
        serviceEnv: env,
        gatewayPort,
        expectedVersion: version,
        expectedBuildId: buildId ?? undefined,
        timeoutMs: params.timeoutMs,
        waitForStartup: params.opts.restart === false ? false : params.waitForStartup,
        assertCurrent: params.assertCurrent,
      });
      params.assertCurrent?.();
      Object.assign(result, appendPluginUpdateWarnings(result, validation.pluginWarnings ?? []));
      // Observed health cannot override an owner's unsafe restart verdict.
      const restartUnsafe = previousRecovery?.serviceRestartSafe === false && !restartAttempted;
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
      if (validation.ok && restartAttempted) {
        warnRecording(
          `Gateway recovered on ${version}; ${result.reason ?? "update recovery"} remains unverified. Recovery artifacts and package backups were retained. Run openclaw update repair.`,
        );
        if (result.reason === "service-definition-rollback-unverified") {
          result.status = "ok";
        }
        if (run) {
          recordUpdateRunDiagnostics(run.runId, { recovery: result.recovery }, warnRecording, run);
        }
      }
    });
  } catch (error) {
    assertRecoveryFailureCurrent(error);
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
      run,
    );
    // Unread history may still prohibit restart until the atomic merge confirms it.
    result.recovery =
      saved?.verification.recovery ??
      (!recorded && result.recovery?.serviceRestartSafe ? undefined : result.recovery);
  }
  return result;
}
