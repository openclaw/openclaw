import type { UpdateScheduleState } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import { isGatewayExternallySupervised } from "./gateway-supervision.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  type UpdateChannel,
} from "./update-channels.js";
import { currentUpdateCheckLifecycle } from "./update-check-lifecycle.js";
import {
  resolveGitScheduleStatus,
  resolveStartupInstallStatus,
  withUpdateInstallStatus,
} from "./update-install-status.js";
import { canRunDevGitCampaign, resolveDevGitUpdate } from "./update-startup-refresh.js";
import {
  getUpdateSchedule,
  setUpdateScheduleCache,
  setUpdateAvailableCache,
  withoutUpdateTarget,
  withoutUpdateCampaign,
} from "./update-status-state.js";

/** Projects scheduler facts independently of optional checkout discovery. */
export function getGatewayUpdateSchedule(
  cfg: OpenClawConfig,
  channel: UpdateChannel,
): UpdateScheduleState {
  const schedule = getUpdateSchedule();

  // Read policy, not discovery success. External supervision must not rewrite
  // the authored auto-update preference, and status must never clear a campaign.
  const campaign = currentUpdateCheckLifecycle().campaign?.getState();
  const facts =
    schedule &&
    (schedule.channel === channel || (campaign && schedule.campaign?.id === campaign.id))
      ? withoutUpdateCampaign(schedule)
      : { channel };
  const result = {
    ...facts,
    autoEnabled:
      Boolean(cfg.update?.auto?.enabled) &&
      cfg.update?.checkOnStart !== false &&
      !isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE),
    ...(campaign ? { campaign } : {}),
  };
  const install = currentUpdateCheckLifecycle().installStatus;
  return install && (install.status.error?.timeoutMs || install.status.installKind === "immutable")
    ? withUpdateInstallStatus(result, install.status, true, install.installReceipt, install.root)
    : result;
}

/** Refreshes read-only checkout and immutable-generation facts used by update.status. */
export function refreshGatewayUpdateStatus(getConfig: () => OpenClawConfig): Promise<void> {
  const cfg = getConfig();
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
      // A config change must not be confused with install-kind adoption below.
      const channelIdentity =
        channel === "dev" ? lifecycle.installStatus?.status : (await lifecycle.initialize()).status;
      const currentChannel = (discoveredStatus = channelIdentity) => {
        // Compare config policy against the same identity across every await.
        // Fresh installation facts are adopted separately after this guard.
        const status = channelIdentity ?? discoveredStatus;
        return (
          normalizeUpdateChannel(getConfig().update?.channel) ??
          (status
            ? resolveEffectiveUpdateChannel({ currentVersion: VERSION, ...status }).channel
            : channel)
        );
      };
      if (channel !== "dev" && channelIdentity?.installKind !== "immutable") {
        // Even a no-op refresh must not confirm a channel changed during initialization.
        if (currentChannel() !== channel) {
          throw new Error("Update check was superseded by a channel change. Try again.");
        }
        return;
      }
      const generation = lifecycle.publicationGeneration;
      const assertCurrent = (discoveredStatus = channelIdentity) => {
        const schedule = getUpdateSchedule();
        const campaign = lifecycle.campaign?.getState();
        if (
          currentChannel(discoveredStatus) !== channel ||
          generation !== lifecycle.publicationGeneration ||
          campaign?.state === "applying" ||
          !lifecycle.isCurrent() ||
          signal.aborted ||
          (campaign && (schedule?.channel !== channel || schedule.campaign?.id !== campaign.id)) ||
          (schedule !== scheduleAtStart && schedule?.channel !== channel)
        ) {
          throw new Error("Update check was superseded by another update operation. Try again.");
        }
      };
      assertCurrent();
      const { root, status, installReceipt } = await resolveStartupInstallStatus(true, signal);
      assertCurrent(status);
      const unavailable =
        status.error ||
        (channel === "dev" && status.installKind === "unknown") ||
        resolveGitScheduleStatus(status, installReceipt, root)?.status === "unavailable";
      // A failed remote fetch does not invalidate freshly read local Git identity.
      const identityUnavailable =
        status.error ||
        status.installKind === "unknown" ||
        (status.installKind === "git" && (!status.git || status.git.error));
      const refreshedChannel = identityUnavailable
        ? channel
        : resolveEffectiveUpdateChannel({
            configChannel: normalizeUpdateChannel(getConfig().update?.channel),
            currentVersion: VERSION,
            ...status,
          }).channel;
      // Repair failed discovery and invalidate generation facts when the adopted
      // installation or prepared receipt changes, including loss of ownership.
      if (
        (lifecycle.installStatus?.status.error && !status.error) ||
        (!status.error &&
          status.installKind !== "unknown" &&
          (lifecycle.installStatus?.status.installKind !== status.installKind ||
            refreshedChannel !== channel)) ||
        lifecycle.installStatus?.status.installKind === "immutable" ||
        status.installKind === "immutable"
      ) {
        lifecycle.installStatus = { root, status, installReceipt };
      }
      const schedule = getUpdateSchedule();
      const current =
        schedule?.channel === refreshedChannel
          ? schedule
          : { channel: refreshedChannel, autoEnabled: Boolean(getConfig().update?.auto?.enabled) };
      const next = withUpdateInstallStatus(current, status, true, installReceipt, root);
      const publishSchedule = (published: UpdateScheduleState) =>
        setUpdateScheduleCache({
          next: published,
          onUpdateScheduleChange: lifecycle.onUpdateScheduleChange,
        });
      const retireGitTarget = () => {
        lifecycle.publicationGeneration += 1;
        setUpdateAvailableCache({
          next: null,
          onUpdateAvailableChange: lifecycle.onUpdateAvailableChange,
        });
        // Retire the schedule first so the campaign callback cannot republish its old target.
        publishSchedule(withoutUpdateTarget(next));
        lifecycle.campaign?.clear();
      };
      if (unavailable) {
        if (refreshedChannel !== channel) {
          retireGitTarget();
        } else {
          // A failed observation alone cannot revoke the last announced campaign.
          publishSchedule(next);
        }
        throw new Error("The latest Dev update could not be checked. Try again.");
      }
      if (refreshedChannel !== "dev" || status.installKind !== "git") {
        // A package check preserves supported package availability, never a
        // target or campaign owned by a Git checkout that no longer exists.
        if (status.installKind === "package" && schedule?.target?.kind !== "git") {
          if (schedule && schedule.channel !== refreshedChannel) {
            lifecycle.publicationGeneration += 1;
            setUpdateAvailableCache({
              next: null,
              onUpdateAvailableChange: lifecycle.onUpdateAvailableChange,
            });
          }
          publishSchedule(next);
          return;
        }
        retireGitTarget();
        return;
      }
      const update = await resolveDevGitUpdate(status, signal);
      assertCurrent(status);
      lifecycle.publicationGeneration += 1;
      const campaign = lifecycle.campaign;
      if (!update) {
        campaign?.clear();
        setUpdateAvailableCache({
          next: null,
          onUpdateAvailableChange: lifecycle.onUpdateAvailableChange,
        });
        publishSchedule(withoutUpdateTarget(next));
        return;
      }
      setUpdateAvailableCache({
        next: update.available,
        onUpdateAvailableChange: lifecycle.onUpdateAvailableChange,
      });
      publishSchedule({ ...next, target: update.target });
      if (
        getGatewayUpdateSchedule(getConfig(), refreshedChannel).autoEnabled &&
        !isGatewayExternallySupervised() &&
        canRunDevGitCampaign(update.git)
      ) {
        campaign?.refreshGitTarget(update.target);
        if (!campaign?.getState()) {
          lifecycle.announceDevGitUpdate?.(update.target, { root, status, installReceipt });
        }
      } else {
        campaign?.clear();
      }
    })
    .finally(() => {
      if (lifecycle.refreshes.get(cfg) === refresh) {
        lifecycle.refreshes.delete(cfg);
      }
    });
  lifecycle.refreshes.set(cfg, refresh);
  return refresh;
}
