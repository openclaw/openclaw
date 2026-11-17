import {
  captureDeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../infra/delivery-queue-state-context.js";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import {
  AUTOMATIC_RECOVERY_CLEANUP_STEP,
  automaticRecoveryCleanupWarning,
  canAutomaticallyCleanUpdateRecovery,
} from "../infra/update-automatic-cleanup-result.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { getUpdateRunAsync as getUpdateRun } from "../infra/update-run-reader.js";
import { projectUpdateRunResultSteps } from "../infra/update-run-step.js";
import {
  finishUpdateRunAsync as finishUpdateRun,
  recordUpdateRunPhaseAsync as recordUpdateRunPhase,
  recordUpdateRunVerificationAsync as recordUpdateRunVerification,
} from "../infra/update-run-write.async.js";
import type { UpdateStepResult } from "../infra/update-step-result.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../version.js";

/** The booting Gateway records only its own observations; the CLI owns pending handoffs. */
export async function finalizeRestartUpdateRun(
  payload: RestartSentinelPayload,
  pendingExpired = false,
  context: DeliveryQueueStateContext = captureDeliveryQueueStateContext(),
  continuation: { signal?: AbortSignal; assertCurrent?: () => void } = {},
) {
  const options = { env: context.workerContext.environment };
  const updateRunId = payload.stats?.runId;
  let updateRun = updateRunId ? await getUpdateRun(updateRunId, options) : undefined;
  if (updateRun?.status === "running") {
    if (!updateRun.origin.sessionKey && payload.sessionKey) {
      updateRun = await recordUpdateRunPhase(
        updateRun.runId,
        updateRun.phase,
        {
          origin: {
            sessionKey: payload.sessionKey,
            ...(payload.deliveryContext
              ? {
                  deliveryContext: {
                    ...payload.deliveryContext,
                    threadId: payload.threadId,
                  },
                }
              : {}),
          },
        },
        options,
      );
    }
    if (
      updateRun.status === "running" &&
      (updateRun.phase === "restarting" || updateRun.phase === "verifying")
    ) {
      updateRun = await recordUpdateRunPhase(updateRun.runId, "verifying", {}, options);
    }
    const runningVersion = resolveRuntimeServiceVersion();
    const runningBuildId = resolveRuntimeServiceBuildId();
    // A failed update's restored boot serves the previous version. The restore
    // owner already verified that identity against the restored disk state and
    // recorded it; regrading this boot against the update target would
    // overwrite the verified fact with a version mismatch. An empty
    // after.version marks that path: target verification never succeeded, so
    // the recorded versionMatch could only have come from the restore. Reuse
    // it only for the exact binary the recorder verified — a boot serving the
    // recorded version under a different (or unverifiable) build is another
    // binary and must be regraded against the update target.
    const recordedBuildId =
      typeof updateRun.verification.runningBuildId === "string"
        ? updateRun.verification.runningBuildId
        : undefined;
    const restoredVerification =
      updateRun.verification.versionMatch === true &&
      !updateRun.after.version &&
      typeof updateRun.verification.runningVersion === "string" &&
      updateRun.verification.runningVersion === runningVersion &&
      (recordedBuildId === undefined || recordedBuildId === runningBuildId);
    const expectedVersion = restoredVerification
      ? runningVersion
      : (updateRun.after.version ?? updateRun.target.version);
    const expectedBuildId = restoredVerification ? undefined : updateRun.after.buildId;
    const pluginErrors = getActivePluginRegistry()
      ?.diagnostics.filter((entry) => entry.level === "error")
      .map((entry) => entry.message);
    updateRun = await recordUpdateRunVerification(
      updateRun.runId,
      {
        booted: true,
        serviceRunning: true,
        pid: process.pid,
        runningVersion,
        ...(runningBuildId ? { runningBuildId } : {}),
        ...(expectedVersion
          ? {
              versionMatch:
                expectedVersion === runningVersion &&
                (!expectedBuildId || expectedBuildId === runningBuildId),
            }
          : {}),
        ...(pluginErrors ? { pluginErrors } : {}),
        ...(payload.doctorHint ? { doctorHint: payload.doctorHint } : {}),
      },
      { ...options, onlyIfRunning: true },
    );
    if (updateRun.phase === "verifying" && updateRun.status === "running") {
      const { createUpdateRunNotifier } = await import("./update-run-notice.runtime.js");
      const notify = await createUpdateRunNotifier(
        updateRun,
        undefined,
        undefined,
        undefined,
        context,
      );
      await notify(updateRun, "verifying");
    }
    // A managed handoff preserves its original trigger, while an unmanaged RPC
    // also reaches restarting. Only the recorded owner can finish CLI verification.
    const orchestratorOwnsVerification =
      updateRun.status === "running" &&
      (updateRun.trigger === "cli" || Boolean(payload.stats?.handoffId));
    if (
      !orchestratorOwnsVerification &&
      (pendingExpired || !isPendingControlPlaneUpdateRestartSentinel(payload))
    ) {
      if (
        !pendingExpired &&
        payload.status === "ok" &&
        updateRun.verification.versionMatch !== false
      ) {
        const { commitRestartPluginCohort } = await import("./server-restart-plugin-cohort.js");
        await commitRestartPluginCohort(updateRun.runId, {
          // The database projection omits the command's HOME, scratch and config selectors.
          env: resolveDeliveryQueueStateEnv(undefined, context),
          signal: continuation.signal,
          assertCurrent: () => {
            continuation.signal?.throwIfAborted();
            continuation.assertCurrent?.();
            context.workerContext.admission.assertCurrent();
          },
        });
      }
      updateRun = await finishUpdateRun(
        updateRun.runId,
        {
          status:
            pendingExpired ||
            payload.status === "error" ||
            updateRun.verification.versionMatch === false
              ? "failed"
              : payload.status === "ok"
                ? "succeeded"
                : "skipped",
          reason:
            pendingExpired || updateRun.verification.versionMatch === false
              ? "restart-unhealthy"
              : (payload.stats?.reason ?? undefined),
          after: {
            version: runningVersion,
            ...(runningBuildId ? { buildId: runningBuildId } : {}),
          },
        },
        options,
      );
    }
  }
  if (
    !pendingExpired &&
    updateRun &&
    canAutomaticallyCleanUpdateRecovery(updateRun) &&
    !updateRun.steps.some(
      (step) => step.step === AUTOMATIC_RECOVERY_CLEANUP_STEP && step.status === "completed",
    )
  ) {
    let cleanup: UpdateStepResult | undefined;
    try {
      const { cleanupGatewayUpdateRecovery } = await import("./update-automatic-cleanup.js");
      cleanup = await cleanupGatewayUpdateRecovery(updateRun.runId, options.env);
    } catch (error) {
      cleanup = automaticRecoveryCleanupWarning(error);
    }
    // Completion must carry the warning even when optional diagnostic writes fail.
    // Required boot/outcome persistence above remains outside this advisory boundary.
    if (cleanup) {
      updateRun = projectUpdateRunResultSteps(updateRun, [cleanup]);
    }
  }
  return updateRun;
}
