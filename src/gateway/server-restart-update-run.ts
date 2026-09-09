import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import {
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../version.js";

/** The booting Gateway records only its own observations; the CLI owns pending handoffs. */
export async function finalizeRestartUpdateRun(
  payload: RestartSentinelPayload,
  pendingExpired = false,
) {
  const updateRunId = payload.stats?.runId;
  let updateRun = updateRunId ? getUpdateRun(updateRunId) : undefined;
  if (updateRun) {
    if (!updateRun.origin.sessionKey && payload.sessionKey) {
      updateRun = recordUpdateRunPhase(updateRun.runId, updateRun.phase, {
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
      });
    }
    if (
      updateRun.status === "running" &&
      (updateRun.phase === "restarting" || updateRun.phase === "verifying")
    ) {
      updateRun = recordUpdateRunPhase(updateRun.runId, "verifying");
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
    updateRun = recordUpdateRunVerification(updateRun.runId, {
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
    });
    if (updateRun.phase === "verifying" && updateRun.status === "running") {
      const { createUpdateRunNotifier } = await import("./update-run-notice.runtime.js");
      await createUpdateRunNotifier(updateRun)(updateRun, "verifying");
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
      updateRun = finishUpdateRun(updateRun.runId, {
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
        after: { version: runningVersion, ...(runningBuildId ? { buildId: runningBuildId } : {}) },
      });
    }
  }
  return updateRun;
}
