import { assertDoctorServiceSelection } from "../../commands/doctor-service-repair-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { tryProcessCwd } from "../../infra/safe-cwd.js";
import { verifyUpdateStateConsistency } from "../../infra/update-data-at-risk.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import {
  dataAtRiskVerifiedStep,
  describeRecordedDataAtRisk,
  findUnverifiedDataAtRisk,
  listUnverifiedDataAtRisk,
  type RecordedDataAtRisk,
} from "../../infra/update-run-data-at-risk.js";
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
import { defaultRuntime } from "../../runtime.js";
import { formatCliCommand } from "../command-format.js";
import {
  renderRestartDiagnostics,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import { readPackageVersion } from "./shared.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";
import {
  assertGatewayServiceAdmissionUnchanged,
  GatewayServiceUpdateOwnershipError,
  inspectManagedGatewayServiceBeforeUpdate,
  readGatewayServiceStateForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import {
  formatDataAtRiskNextSteps,
  formatDataAtRiskRefusal,
  formatDataAtRiskResolved,
  observeGatewayForGuidance,
} from "./update-data-at-risk-guidance.js";
import type {
  UpdateFinalizationLifecycle,
  UpdateFinalizationPhase,
} from "./update-finalization-lifecycle.js";

function stoppedGatewayGuidance(reason: string, env: NodeJS.ProcessEnv): string {
  return `Gateway service remains stopped: ${reason}. After resolving this, start it with \`${formatCliCommand("openclaw gateway start", env)}\`, then check \`${formatCliCommand("openclaw gateway status --deep", env)}\`.`;
}

/**
 * Check a recorded data-at-risk mark against the state on disk. Consistent: record the
 * receipt on the repair run and return undefined. Otherwise return the refusal to report;
 * nothing is changed.
 */
export async function verifyRecordedDataAtRisk(params: {
  /** Newest first; one verification settles them all. */
  marks: readonly RecordedDataAtRisk[];
  repairRunId: string;
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  json: boolean;
  phase: UpdateFinalizationPhase;
  timeoutMs: number;
  /** Before Doctor runs: what Doctor's maintenance settles is deferred to it. */
  beforeMaintenance?: true;
  /** After this run's Doctor maintenance held exclusive state ownership. */
  writersExcluded?: true;
}): Promise<string | undefined> {
  const { env, phase, marks } = params;
  const verification = await verifyUpdateStateConsistency({
    env,
    formatCommand: (command) => formatCliCommand(command, env),
    marks,
    writersExcluded: params.writersExcluded,
    signal: phase.signal,
  });
  phase.assertCurrent();
  if (params.beforeMaintenance && verification.status !== "consistent" && verification.finishable) {
    return undefined;
  }
  if (verification.status !== "consistent") {
    return formatDataAtRiskRefusal({
      marks,
      verification,
      gateway: await observeGatewayForGuidance({
        service: resolveGatewayService(),
        env,
        config: params.config,
        timeoutMs: params.timeoutMs,
      }),
      // After Doctor, its maintenance may already have parked and restored the Gateway.
      outcome: `${params.beforeMaintenance ? "Repair left the Gateway as it was." : "Repair did not start or restart the Gateway after this check."} ${formatDataAtRiskNextSteps(verification, env)}`,
    });
  }
  const resolved = formatDataAtRiskResolved({ marks, verification });
  for (const { runId } of marks) {
    recordUpdateRunStep(
      params.repairRunId,
      {
        step: dataAtRiskVerifiedStep(runId),
        status: "completed",
        endedAtMs: Date.now(),
        detail: resolved,
      },
      { env },
    );
  }
  defaultRuntime[params.json ? "error" : "log"](resolved);
  return undefined;
}

/** Whether recent history holds a data-at-risk mark no run has verified. */
export function hasUnverifiedDataAtRisk(): boolean {
  return listUnverifiedDataAtRisk(listUpdateRuns({ limit: 100 })).length > 0;
}

/** Verify every unverified mark in recent history for a repair or finalization run. */
export async function verifyUnverifiedDataAtRisk(
  params: Omit<Parameters<typeof verifyRecordedDataAtRisk>[0], "marks" | "env">,
): Promise<string | undefined> {
  const marks = listUnverifiedDataAtRisk(listUpdateRuns({ limit: 100 }));
  return marks.length > 0
    ? await verifyRecordedDataAtRisk({
        ...params,
        marks,
        env: resolveServiceRefreshEnv(process.env, tryProcessCwd()),
      })
    : undefined;
}

/**
 * Before Doctor may park and restart the Gateway, refuse an inconsistent recorded mark so
 * nothing changes; an unfinished migration is left for Doctor and checked again after it.
 */
export async function refuseUnverifiedDataAtRiskBeforeMaintenance(
  lifecycle: Pick<UpdateFinalizationLifecycle, "run" | "budget">,
  repairRunId: string,
  json: boolean | undefined,
): Promise<void> {
  if (!hasUnverifiedDataAtRisk()) {
    return;
  }
  const refusal = await lifecycle.run("preflight", (phase) =>
    verifyUnverifiedDataAtRisk({
      repairRunId,
      json: Boolean(json),
      phase,
      timeoutMs: lifecycle.budget("preflight"),
      beforeMaintenance: true,
    }),
  );
  if (refusal) {
    throw new Error(refusal);
  }
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
  // A mark stays on its run; a receipt from this or an earlier repair resolves it.
  const risk = () =>
    findUnverifiedDataAtRisk(
      getUpdateRun(originalRunId, { env }),
      listUpdateRuns({ limit: 100 }, { env }),
    );
  const service = resolveGatewayService();
  const mark = risk();
  const original = getUpdateRun(originalRunId, { env });
  if (mark && original) {
    const refusal = await verifyRecordedDataAtRisk({
      ...params,
      marks: [describeRecordedDataAtRisk(original, mark)],
    });
    if (refusal) {
      return { restart: false, warning: refusal };
    }
  }
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
          `Update ${originalRunId} recorded data at risk (${dataAtRisk}) that this repair did not verify; the Gateway was not started. Run \`${formatCliCommand("openclaw update repair", env)}\` again.`,
        );
      }
    };
    const state = await readGatewayServiceStateForUpdate(service, env, params.timeoutMs);
    assertDoctorServiceSelection(env, state.env);
    const verdict = await inspectManagedGatewayServiceBeforeUpdate({ root: params.root, state });
    assertCurrent();
    if (verdict.kind !== "owned") {
      return {
        restart: false,
        warning: stoppedGatewayGuidance("its ownership could not be verified", env),
      };
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
