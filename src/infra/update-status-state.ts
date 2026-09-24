import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import type { UpdateChannel } from "./update-channels.js";

export type { UpdateAvailable } from "../../packages/gateway-protocol/src/index.js";

let updateAvailableCache: UpdateAvailable | null = null;
let updateScheduleCache: UpdateScheduleState | null = null;

export function getUpdateAvailable(): UpdateAvailable | null {
  return updateAvailableCache;
}

export function getUpdateSchedule(): UpdateScheduleState | null {
  return updateScheduleCache;
}

function sameUpdateAvailable(a: UpdateAvailable | null, b: UpdateAvailable | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return (
    a.currentVersion === b.currentVersion &&
    a.latestVersion === b.latestVersion &&
    a.channel === b.channel &&
    a.currentSha === b.currentSha &&
    a.upstreamRef === b.upstreamRef &&
    a.upstreamSha === b.upstreamSha &&
    a.repositoryUrl === b.repositoryUrl &&
    a.commitsBehind === b.commitsBehind &&
    JSON.stringify(a.commits) === JSON.stringify(b.commits)
  );
}

function sameUpdateSchedule(a: UpdateScheduleState | null, b: UpdateScheduleState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function setUpdateScheduleCache(params: {
  next: UpdateScheduleState;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
}): void {
  if (sameUpdateSchedule(updateScheduleCache, params.next)) {
    return;
  }
  updateScheduleCache = params.next;
  params.onUpdateScheduleChange?.(params.next);
}

export function setUpdateAvailableCache(params: {
  next: UpdateAvailable | null;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
}): void {
  if (sameUpdateAvailable(updateAvailableCache, params.next)) {
    return;
  }
  updateAvailableCache = params.next;
  params.onUpdateAvailableChange?.(params.next);
}

export function resetUpdateStatusState(): void {
  updateAvailableCache = null;
  updateScheduleCache = null;
}

export type UpdateCheckState = {
  lastCheckedAt?: string;
  lastCheckedChannel?: UpdateChannel;
  lastNotifiedVersion?: string;
  lastNotifiedTag?: string;
  lastAvailableVersion?: string;
  lastAvailableTag?: string;
  autoInstallId?: string;
  autoFirstSeenVersion?: string;
  autoFirstSeenTag?: string;
  autoFirstSeenAt?: string;
  autoLastAttemptVersion?: string;
  autoLastAttemptAt?: string;
};

export function withoutCampaign(schedule: UpdateScheduleState): UpdateScheduleState {
  const { campaign: _campaign, ...rest } = schedule;
  return rest;
}

export function withoutTarget(schedule: UpdateScheduleState): UpdateScheduleState {
  const { target: _target, campaign: _campaign, ...rest } = schedule;
  return rest;
}

export function clearAvailabilityState(nextState: UpdateCheckState): void {
  delete nextState.lastAvailableVersion;
  delete nextState.lastAvailableTag;
}

export function clearAutoState(nextState: UpdateCheckState): void {
  delete nextState.autoFirstSeenVersion;
  delete nextState.autoFirstSeenTag;
  delete nextState.autoFirstSeenAt;
}
