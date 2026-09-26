import { performance } from "node:perf_hooks";
import {
  validateUpdateHoldParams,
  validateUpdateHoldResult,
  validateUpdateRunsGetParams,
  validateUpdateRunsListParams,
  validateUpdateStatusParams,
  validateUpdateStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveOcmUpdateManager } from "../../infra/ocm-update-client.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { gatewayUpdateCampaign } from "../../infra/update-campaign.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import {
  getUpdateRunAsync,
  getUpdateRunWithReconciliationAsync,
  getUpdateRunStatusAsync,
  listUpdateRunsAsync,
  reconcileAbandonedUpdateRunsAsync,
} from "../../infra/update-run-ledger.js";
import { toPublicUpdateRun } from "../../infra/update-run-record.js";
import { getUpdateEffectiveChannel } from "../../infra/update-startup.js";
import {
  getGatewayUpdateSchedule,
  refreshGatewayUpdateStatus,
} from "../../infra/update-status-schedule.js";
import { getUpdateAvailable, getUpdateSchedule } from "../../infra/update-status-state.js";
import {
  getGatewayRestartDrainSignal,
  getGatewaySuspendAdmissionPhase,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import {
  getLatestUpdateRestartSentinel,
  refreshLatestUpdateRestartSentinel,
} from "../server-restart-sentinel.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const updateStatusHandlers: GatewayRequestHandlers = {
  "update.status": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateUpdateStatusParams, "update.status", respond)) {
      return;
    }
    const startedAt = areDiagnosticsEnabledForProcess() ? performance.now() : undefined;
    const timing =
      startedAt === undefined ? undefined : createStageTimingTracker(() => performance.now());
    let phase = "sentinel";
    const mark = (next: string) => {
      timing?.mark(phase);
      phase = next;
    };
    try {
      let manager = await resolveOcmUpdateManager();
      const managedRun = manager ? await manager.status() : null;
      if (manager && !manager.canStart && !managedRun) {
        manager = null;
      }
      let sentinel: RestartSentinelPayload | null;
      try {
        sentinel = manager ? null : await refreshLatestUpdateRestartSentinel();
      } catch (err) {
        context?.logGateway?.warn(
          `update.status sentinel refresh failed: ${formatErrorMessage(err)}`,
        );
        sentinel = getLatestUpdateRestartSentinel();
      }
      mark("checkout");
      const config = context?.getRuntimeConfig?.();
      if (params.refreshCheckout === true && config) {
        try {
          await refreshGatewayUpdateStatus(config);
        } catch (err) {
          context?.logGateway?.warn(
            `update.status checkout refresh failed: ${formatErrorMessage(err)}`,
          );
        }
      }
      mark("reconciliation");
      try {
        if (!manager) {
          await reconcileAbandonedUpdateRunsAsync();
        }
      } catch (error) {
        context?.logGateway?.warn(
          `update.status reconciliation failed: ${formatErrorMessage(error)}`,
        );
      }
      mark("history");
      const { activeRun, lastRun } = manager
        ? {
            activeRun: managedRun?.status === "running" ? managedRun : undefined,
            lastRun: managedRun?.status !== "running" ? (managedRun ?? undefined) : undefined,
          }
        : await getUpdateRunStatusAsync();
      const campaignRunId = gatewayUpdateCampaign.getRunId();
      const campaignRun =
        !campaignRunId || lastRun?.runId === campaignRunId
          ? lastRun
          : activeRun?.runId === campaignRunId
            ? activeRun
            : await getUpdateRunAsync(campaignRunId).catch((error: unknown) => {
                context?.logGateway?.warn(
                  `update.status campaign run lookup failed: ${formatErrorMessage(error)}`,
                );
                return undefined;
              });
      gatewayUpdateCampaign.reconcileRun(campaignRun);
      mark("identity");
      let currentConfig = context?.getRuntimeConfig?.() ?? config;
      let effectiveChannel =
        normalizeUpdateChannel(currentConfig?.update?.channel) ??
        (currentConfig ? undefined : normalizeUpdateChannel(getUpdateSchedule()?.channel));
      if (!effectiveChannel) {
        try {
          effectiveChannel = await getUpdateEffectiveChannel();
        } catch (err) {
          context?.logGateway?.warn(
            `update.status install identity failed: ${formatErrorMessage(err)}`,
          );
        }
        currentConfig = context?.getRuntimeConfig?.() ?? currentConfig;
        effectiveChannel =
          normalizeUpdateChannel(currentConfig?.update?.channel) ?? effectiveChannel;
      }
      const schedule = currentConfig
        ? effectiveChannel
          ? getGatewayUpdateSchedule(currentConfig, effectiveChannel)
          : undefined
        : getUpdateSchedule();
      mark("response");
      const result = {
        sentinel,
        ...(activeRun ? { activeRun: toPublicUpdateRun(activeRun) } : {}),
        ...(lastRun ? { lastRun: toPublicUpdateRun(lastRun) } : {}),
        updateAvailable: getUpdateAvailable(),
        ...(effectiveChannel ? { effectiveChannel } : {}),
        ...(schedule ? { schedule } : {}),
      };
      if (!validateUpdateStatusResult(result)) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "update status is temporarily unavailable",
        });
        return;
      }
      respond(true, result);
    } finally {
      if (timing && startedAt !== undefined && areDiagnosticsEnabledForProcess()) {
        timing.mark(phase);
        const { totalMs, stages } = timing.snapshot();
        if (performance.now() - startedAt >= 1_000) {
          try {
            context?.logGateway?.warn("update.status: slow request", {
              operation: "update.status",
              elapsedMs: totalMs,
              phaseDurationsMs: Object.fromEntries(
                stages.map(({ name, durationMs }) => [name, durationMs]),
              ),
            });
          } catch {
            // Diagnostics must not replace the response or the original error.
          }
        }
      }
    }
  },
  "update.hold": ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateUpdateHoldParams, "update.hold", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const campaignBeforeHold = gatewayUpdateCampaign.getState();
    const ok = gatewayUpdateCampaign.hold();
    const schedule = getUpdateSchedule();
    if (ok) {
      const heldCampaign = gatewayUpdateCampaign.getState();
      context?.logGateway?.info(
        `update.hold granted ${formatControlPlaneActor(actor)} holdUntilMs=${heldCampaign?.holdUntilMs} forceAtMs=${heldCampaign?.forceAtMs}`,
      );
    } else {
      const reason = !campaignBeforeHold
        ? "no campaign"
        : campaignBeforeHold.state === "applying"
          ? "applying"
          : "already held";
      context?.logGateway?.info(`update.hold refused ${formatControlPlaneActor(actor)}`, {
        reason,
      });
    }
    const result = {
      ok,
      ...(schedule ? { schedule } : {}),
    };
    if (!validateUpdateHoldResult(result)) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "update hold status is temporarily unavailable",
      });
      return;
    }
    respond(true, result);
  },
  "update.runs.get": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateUpdateRunsGetParams, "update.runs.get", respond)) {
      return;
    }
    if (params.runId.startsWith("ocm:")) {
      const manager = await resolveOcmUpdateManager();
      if (!manager) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "The OCM update manager is unavailable for this Gateway.",
        });
        return;
      }
      respond(true, { run: await manager.status(params.runId) });
      return;
    }
    // Lazy handler preparation can outlast an in-process restart. Reacquire
    // root ownership before reconciliation if the new runtime reopened admission.
    const admission = tryBeginGatewayRootWorkAdmission("ws:update.runs.get");
    if (!admission) {
      if (
        !getGatewayRestartDrainSignal().aborted ||
        getGatewaySuspendAdmissionPhase() !== "accepting"
      ) {
        respond(false, undefined, {
          code: "UNAVAILABLE",
          message: "update.runs.get unavailable during gateway restart or suspension",
        });
        return;
      }
      // Only committed drain is one-way: a reversible signal could roll back
      // while this unrooted read awaits the database worker.
      const run = await getUpdateRunAsync(params.runId);
      respond(true, { run: run ? toPublicUpdateRun(run) : null });
      return;
    }
    try {
      const { run, reconciliationError } = await admission.run(() =>
        getUpdateRunWithReconciliationAsync(params.runId),
      );
      if (reconciliationError) {
        context?.logGateway?.warn(`update.runs.get reconciliation failed: ${reconciliationError}`);
      }
      respond(true, { run: run ? toPublicUpdateRun(run) : null });
    } finally {
      admission.release();
    }
  },
  "update.runs.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateRunsListParams, "update.runs.list", respond)) {
      return;
    }
    respond(true, { runs: (await listUpdateRunsAsync(params)).map(toPublicUpdateRun) });
  },
};
