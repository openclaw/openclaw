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
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { gatewayUpdateCampaign } from "../../infra/update-campaign.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import {
  getUpdateRunWithReconciliationAsync,
  getUpdateRunStatusAsync,
  listUpdateRunsAsync,
  reconcileAbandonedUpdateRunsAsync,
} from "../../infra/update-run-ledger.js";
import {
  getUpdateEffectiveChannel,
  refreshGatewayUpdateStatus,
} from "../../infra/update-startup.js";
import { getUpdateAvailable, getUpdateSchedule } from "../../infra/update-status-state.js";
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
      let sentinel: RestartSentinelPayload | null;
      try {
        sentinel = await refreshLatestUpdateRestartSentinel();
      } catch (err) {
        context?.logGateway?.warn(
          `update.status sentinel refresh failed: ${formatErrorMessage(err)}`,
        );
        sentinel = getLatestUpdateRestartSentinel();
      }
      mark("checkout");
      const config = context?.getRuntimeConfig?.();
      const configChannel = normalizeUpdateChannel(config?.update?.channel);
      if (params.refreshCheckout === true && config) {
        try {
          await refreshGatewayUpdateStatus(config);
        } catch (err) {
          context?.logGateway?.warn(
            `update.status checkout refresh failed: ${formatErrorMessage(err)}`,
          );
        }
      }
      mark("identity");
      const schedule = getUpdateSchedule();
      let effectiveChannel = configChannel ?? normalizeUpdateChannel(schedule?.channel);
      if (!effectiveChannel) {
        try {
          effectiveChannel = await getUpdateEffectiveChannel();
        } catch (err) {
          context?.logGateway?.warn(
            `update.status install identity failed: ${formatErrorMessage(err)}`,
          );
        }
      }
      mark("reconciliation");
      try {
        await reconcileAbandonedUpdateRunsAsync();
      } catch (error) {
        context?.logGateway?.warn(
          `update.status reconciliation failed: ${formatErrorMessage(error)}`,
        );
      }
      mark("history");
      const { activeRun, lastRun } = await getUpdateRunStatusAsync();
      mark("response");
      const result = {
        sentinel,
        ...(activeRun ? { activeRun } : {}),
        ...(lastRun ? { lastRun } : {}),
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
    const { run, reconciliationError } = await getUpdateRunWithReconciliationAsync(params.runId);
    if (reconciliationError) {
      context?.logGateway?.warn(`update.runs.get reconciliation failed: ${reconciliationError}`);
    }
    respond(true, { run: run ?? null });
  },
  "update.runs.list": async ({ params, respond }) => {
    if (!assertValidParams(params, validateUpdateRunsListParams, "update.runs.list", respond)) {
      return;
    }
    respond(true, { runs: await listUpdateRunsAsync(params) });
  },
};
