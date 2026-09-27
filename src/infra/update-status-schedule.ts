import type { UpdateScheduleState } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import { gatewayUpdateCampaign } from "./update-campaign.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  type UpdateChannel,
} from "./update-channels.js";
import { currentUpdateCheckLifecycle } from "./update-check-lifecycle.js";
import { resolveStartupInstallStatus, withUpdateInstallStatus } from "./update-install-status.js";
import { getUpdateSchedule, setUpdateScheduleCache } from "./update-status-state.js";

/** Projects scheduler facts independently of optional checkout discovery. */
export function getGatewayUpdateSchedule(
  cfg: OpenClawConfig,
  channel: UpdateChannel,
): UpdateScheduleState {
  const schedule = getUpdateSchedule();

  // Read policy, not discovery success. External supervision must not rewrite
  // the authored auto-update preference, and status must never clear a campaign.
  const campaign = gatewayUpdateCampaign.getState();
  const { campaign: _cachedCampaign, ...cachedFacts } = schedule ?? {
    channel,
    campaign: undefined,
  };
  const facts =
    schedule &&
    (schedule.channel === channel || (campaign && schedule.campaign?.id === campaign.id))
      ? cachedFacts
      : { channel };
  return {
    ...facts,
    autoEnabled:
      Boolean(cfg.update?.auto?.enabled) &&
      cfg.update?.checkOnStart !== false &&
      !isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE),
    ...(campaign ? { campaign } : {}),
  };
}

/** Refreshes the read-only Dev checkout comparison used by update.status. */
export function refreshGatewayUpdateStatus(cfg: OpenClawConfig): Promise<void> {
  const lifecycle = currentUpdateCheckLifecycle();
  const pending = lifecycle.refreshes.get(cfg);
  if (pending) {
    return pending;
  }
  const refresh = lifecycle
    .run(async (signal) => {
      const scheduleAtStart = getUpdateSchedule();
      const configured = normalizeUpdateChannel(cfg.update?.channel);
      const channel =
        configured ??
        resolveEffectiveUpdateChannel({
          currentVersion: VERSION,
          ...(await lifecycle.initialize()).status,
        }).channel;
      const isCurrent = () => {
        const schedule = getUpdateSchedule();
        const campaign = gatewayUpdateCampaign.getState();
        return (
          lifecycle.isCurrent() &&
          !signal.aborted &&
          (!campaign || (schedule?.channel === channel && schedule.campaign?.id === campaign.id)) &&
          (schedule === scheduleAtStart || schedule?.channel === channel)
        );
      };
      if (channel !== "dev" || !isCurrent()) {
        return;
      }
      const { root, status, installReceipt } = await resolveStartupInstallStatus(true, signal);
      if (!isCurrent()) {
        return;
      }
      const schedule = getUpdateSchedule();
      const current =
        schedule?.channel === channel
          ? schedule
          : { channel, autoEnabled: Boolean(cfg.update?.auto?.enabled) };
      setUpdateScheduleCache({
        next: withUpdateInstallStatus(current, status, true, installReceipt, root),
      });
    })
    .finally(() => {
      if (lifecycle.refreshes.get(cfg) === refresh) {
        lifecycle.refreshes.delete(cfg);
      }
    });
  lifecycle.refreshes.set(cfg, refresh);
  return refresh;
}
