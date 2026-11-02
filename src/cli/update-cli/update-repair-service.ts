import { assertDoctorServiceSelection } from "../../commands/doctor-service-repair-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { findUpdateGatewayStop } from "../../infra/update-run-gateway-stop.js";
import {
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { formatCliCommand } from "../command-format.js";
import {
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import { readPackageVersion } from "./shared.js";
import {
  assertGatewayServiceAdmissionUnchanged,
  GatewayServiceUpdateOwnershipError,
  inspectManagedGatewayServiceBeforeUpdate,
  readGatewayServiceStateForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import type { UpdateFinalizationPhase } from "./update-finalization-lifecycle.js";

function stoppedGatewayGuidance(reason: string, env: NodeJS.ProcessEnv): string {
  return `Gateway service remains stopped: ${reason}. After resolving this, start it with \`${formatCliCommand("openclaw gateway start", env)}\`, then check \`${formatCliCommand("openclaw gateway status --deep", env)}\`.`;
}

export async function restoreRepairGateway(params: {
  originalRunId: string;
  repairRunId: string;
  root: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  json: boolean;
  phase: UpdateFinalizationPhase;
  timeoutMs: number;
}): Promise<{
  restart: boolean;
  warning?: string;
  verification?: UpdateRunRecord["verification"];
}> {
  const { env, phase, originalRunId } = params;
  const runIds = [originalRunId, params.repairRunId];
  const original = () => getUpdateRun(originalRunId, { env });
  const risk = () => {
    const recovery = original()?.verification.recovery;
    return recovery?.serviceRestartSafe === false ? recovery.dataAtRisk : undefined;
  };
  const warning = risk();
  if (warning) {
    return {
      restart: false,
      warning: `Gateway remains stopped: ${warning}. Run openclaw gateway status --deep.`,
    };
  }
  const service = resolveGatewayService();
  return await withGatewayServiceOperationLock(env, async (assertNative) => {
    const readPendingStop = () => {
      const pending = findUpdateGatewayStop(listUpdateRuns({ limit: 100 }, { env }));
      if (!pending || pending.runId !== originalRunId) {
        throw new Error(
          "Recovered update's Gateway stop intent changed. Run openclaw gateway status --deep.",
        );
      }
      return pending;
    };
    const assertCurrent = () => {
      assertNative();
      phase.assertCurrent();
      const dataAtRisk = risk();
      if (dataAtRisk) {
        throw new Error(
          `Gateway remains stopped: ${dataAtRisk}. Run openclaw gateway status --deep.`,
        );
      }
    };
    const state = await readGatewayServiceStateForUpdate(service, env, params.timeoutMs);
    assertDoctorServiceSelection(env, state.env);
    const verdict = await inspectManagedGatewayServiceBeforeUpdate({ root: params.root, state });
    assertCurrent();
    if (verdict.kind !== "owned") {
      throw new Error(
        "Recovered update's Gateway service ownership could not be verified. Run openclaw gateway status --deep.",
      );
    }
    const port = await resolveUpdatedGatewayRestartPort({
      config: params.config,
      serviceEnv: state.env,
      serviceCommand: state.command,
    });
    const expectedVersion = await readPackageVersion(params.root);
    const expectedBuildId = await readBuiltGatewayBuildId(params.root);
    await assertUpdateRecoveryAdmission({ env });
    assertCurrent();
    if (!state.running && readPendingStop().started) {
      return {
        restart: false,
        warning: stoppedGatewayGuidance(
          "it was already started after this update and is now stopped again",
          env,
        ),
      };
    }
    const restart = !state.running;
    if (restart) {
      const beforeMutation = async () => {
        await assertUpdateRecoveryAdmission({ env });
        const current = await readGatewayServiceStateForUpdate(service, env, params.timeoutMs);
        assertDoctorServiceSelection(env, current.env);
        const serviceUpdateVerdict = await inspectManagedGatewayServiceBeforeUpdate({
          root: params.root,
          state: current,
        });
        assertGatewayServiceAdmissionUnchanged(
          { serviceUpdateVerdict: verdict },
          serviceUpdateVerdict,
        );
        if (readPendingStop().started) {
          throw new Error(
            "Recovered update's Gateway stop intent changed. Run openclaw gateway status --deep.",
          );
        }
        assertCurrent();
      };
      await beforeMutation();
      await service.start({
        env: state.env,
        stdout: params.json ? process.stderr : process.stdout,
        preserveDefinition: true,
        assertCurrent,
        beforeEffect: assertCurrent,
        beforeMutation,
      });
    }
    // Keep startup evidence independent of readiness failures and later stopped snapshots.
    recordUpdateRunStep(
      params.repairRunId,
      {
        step: restart ? "service-start" : "service-running",
        status: "completed",
        endedAtMs: Date.now(),
      },
      { env },
    );
    const health = await waitForGatewayHealthyRestart({
      service,
      port,
      env: state.env,
      requireRunningService: true,
      expectedVersion,
      expectedBuildId,
      timeoutMs: params.timeoutMs,
      signal: phase.signal,
    });
    assertCurrent();
    const verification = {
      serviceRunning: health.runtime.status === "running",
      pid: health.runtime.pid,
      port,
      runningVersion: health.gatewayVersion ?? undefined,
      runningBuildId: health.gatewayBuildId ?? undefined,
      versionMatch: health.healthy && health.gatewayVersion === expectedVersion,
      coreReady: health.healthy,
      readyz: health.healthy,
      settled: health.outcome === "ready",
      pluginErrors: (health.activatedPluginErrors ?? []).map((error) => JSON.stringify(error)),
    };
    for (const runId of runIds) {
      recordUpdateRunVerification(runId, verification, { env });
    }
    if (health.outcome !== "ready") {
      throw new Error(
        `Gateway recovery was not verified: ${renderRestartDiagnostics(health).join(" ")} Run openclaw gateway status --deep.`,
      );
    }
    return { restart, verification };
  }).catch((error: unknown) => {
    if (hasCommandProcessCleanupError(error) || risk()) {
      throw error;
    }
    // An unmanaged service (for example a non-default state dir) is not this
    // repair's to start; name the next step instead of failing the repair.
    if (error instanceof GatewayServiceUpdateOwnershipError) {
      return { restart: false, warning: stoppedGatewayGuidance(error.message, env) };
    }
    throw new Error(
      `Gateway recovery after update repair failed: ${formatErrorMessage(error)}. After resolving the failure, start it with \`${formatCliCommand("openclaw gateway start", env)}\`, then check \`${formatCliCommand("openclaw gateway status --deep", env)}\`.`,
      { cause: error },
    );
  });
}
