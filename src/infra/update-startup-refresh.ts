// Owns fresh Dev checkout observations shared by interactive and background checks.
import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { VERSION } from "../version.js";
import { gatewayUpdateCampaign } from "./update-campaign.js";
import { normalizeUpdateChannel, resolveEffectiveUpdateChannel } from "./update-channels.js";
import { currentUpdateCheckLifecycle } from "./update-check-lifecycle.js";
import type { UpdateCheckResult } from "./update-check.js";
import { resolveDevGitCommits } from "./update-git-metadata.js";
import {
  resolveGitScheduleStatus,
  resolveStartupInstallStatus,
  withUpdateInstallStatus,
} from "./update-install-status.js";
import {
  getUpdateSchedule,
  setUpdateAvailableCache,
  setUpdateScheduleCache,
} from "./update-status-state.js";

export function withoutTarget(schedule: UpdateScheduleState): UpdateScheduleState {
  const { target: _target, campaign: _campaign, ...rest } = schedule;
  return rest;
}

export async function resolveDevGitUpdate(status: UpdateCheckResult, signal: AbortSignal) {
  signal.throwIfAborted();
  const git = status.git;
  if (
    status.installKind !== "git" ||
    git?.fetchOk !== true ||
    typeof git.behind !== "number" ||
    git.behind <= 0 ||
    !git.sha ||
    !git.upstream ||
    !git.upstreamSha
  ) {
    return null;
  }
  const currentSha = git.sha;
  const upstreamRef = git.upstream;
  const upstreamSha = git.upstreamSha;
  const commitsBehind = git.behind;
  const commits = await resolveDevGitCommits({ root: git.root, currentSha, upstreamSha, signal });
  signal.throwIfAborted();
  const target: Extract<UpdateScheduleState["target"], { kind: "git" }> = {
    kind: "git",
    upstreamRef,
    upstreamSha,
    commitsBehind,
  };
  const available: UpdateAvailable = {
    currentVersion: VERSION,
    latestVersion: VERSION,
    channel: "dev",
    currentSha,
    upstreamRef,
    upstreamSha,
    ...(git.repositoryUrl ? { repositoryUrl: git.repositoryUrl } : {}),
    commitsBehind,
    commits,
  };
  return { git, target, available };
}

/** Refreshes the Dev checkout and available target without starting an update. */
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
      if (
        (configured && configured !== "dev") ||
        gatewayUpdateCampaign.getState()?.state === "applying"
      ) {
        return;
      }
      const devGitCheckGeneration = ++lifecycle.devGitCheckGeneration;
      // Use the existing Git discovery budget and lifecycle-owned cancellation.
      const { root, status, installReceipt } = await resolveStartupInstallStatus(true, signal);
      const channel =
        configured ?? resolveEffectiveUpdateChannel({ currentVersion: VERSION, ...status }).channel;
      const isCurrent = () => {
        if (
          !lifecycle.isCurrent() ||
          signal.aborted ||
          gatewayUpdateCampaign.getState()?.state === "applying" ||
          (getUpdateSchedule() !== scheduleAtStart && getUpdateSchedule()?.channel !== channel)
        ) {
          return false;
        }
        if (lifecycle.devGitCheckGeneration !== devGitCheckGeneration) {
          throw new Error("Update check was superseded by a newer check. Try again.");
        }
        return true;
      };
      if (channel !== "dev" || status.installKind !== "git" || !isCurrent()) {
        return;
      }
      const comparison = resolveGitScheduleStatus(status, installReceipt, root);
      const update =
        comparison?.status === "unavailable" ? null : await resolveDevGitUpdate(status, signal);
      if (!isCurrent()) {
        return;
      }
      if (update) {
        if (!gatewayUpdateCampaign.reconcileTarget(update.target)) {
          return;
        }
      } else {
        gatewayUpdateCampaign.clear();
      }
      // Reconciliation can clear a waiting campaign through its status callback.
      // Read the schedule afterward so the refresh cannot revive its old target.
      const schedule = getUpdateSchedule();
      const current =
        schedule?.channel === channel
          ? schedule
          : { channel, autoEnabled: Boolean(cfg.update?.auto?.enabled) };
      const next = withUpdateInstallStatus(current, status, true, installReceipt, root);
      setUpdateAvailableCache({
        next: update?.available ?? null,
        onUpdateAvailableChange: lifecycle.onUpdateAvailableChange,
      });
      setUpdateScheduleCache({
        next: update ? { ...next, target: update.target } : withoutTarget(next),
        onUpdateScheduleChange: lifecycle.onUpdateScheduleChange,
      });
      if (next.install?.git?.status === "unavailable") {
        throw new Error("The latest Dev update could not be checked. Try again.");
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
