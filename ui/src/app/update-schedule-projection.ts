import type { GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatCountdown } from "../lib/format.ts";
import {
  readUpdateAvailable,
  readUpdateAvailableValue,
  readUpdateSchedule,
  readUpdateScheduleValue,
} from "./update-schedule-dto.ts";

type UpdateScheduleProjection = {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateCampaignStatusHydrated: boolean;
};

function retainCampaignStatusHydration(
  current: UpdateScheduleState | null,
  next: UpdateScheduleState | null | undefined,
  hydrated: boolean,
): boolean {
  const currentCampaign = current?.campaign;
  const nextCampaign = next?.campaign;
  return (
    !nextCampaign ||
    (hydrated &&
      currentCampaign?.id === nextCampaign.id &&
      currentCampaign.updatedAtMs === nextCampaign.updatedAtMs)
  );
}

export function resolveHeldUpdateCampaignId(
  schedule: UpdateScheduleState | null,
  currentCampaignId: string | null,
): string | null {
  return schedule?.campaign?.holdUntilMs !== undefined ? schedule.campaign.id : currentCampaignId;
}

export function projectConnectedUpdateSnapshot(
  current: UpdateScheduleProjection,
  hello: GatewayHelloOk | null,
): UpdateScheduleProjection {
  const updateSchedule = readUpdateSchedule(hello);
  return {
    updateAvailable: readUpdateAvailable(hello),
    updateSchedule,
    heldUpdateCampaignId: resolveHeldUpdateCampaignId(updateSchedule, current.heldUpdateCampaignId),
    updateCampaignStatusHydrated: retainCampaignStatusHydration(
      current.updateSchedule,
      updateSchedule,
      current.updateCampaignStatusHydrated,
    ),
  };
}

export function projectUpdateAvailableEvent(
  current: UpdateScheduleProjection,
  payload: { updateAvailable?: unknown; schedule?: unknown } | undefined,
): Partial<UpdateScheduleProjection> {
  const updateSchedule =
    payload && Object.hasOwn(payload, "schedule")
      ? readUpdateScheduleValue(payload.schedule)
      : undefined;
  return {
    updateAvailable: readUpdateAvailableValue(payload?.updateAvailable),
    ...(updateSchedule !== undefined
      ? {
          updateSchedule,
          heldUpdateCampaignId: resolveHeldUpdateCampaignId(
            updateSchedule,
            current.heldUpdateCampaignId,
          ),
          updateCampaignStatusHydrated: retainCampaignStatusHydration(
            current.updateSchedule,
            updateSchedule,
            current.updateCampaignStatusHydrated,
          ),
        }
      : {}),
  };
}

export function formatUpdateCampaignLabel(
  schedule: UpdateScheduleState | null | undefined,
  nowMs = Date.now(),
): string | null {
  const campaign = schedule?.campaign;
  if (!campaign) {
    return null;
  }
  if (campaign.state === "applying") {
    return t("updates.campaign.applying");
  }
  if (campaign.holdUntilMs !== undefined && campaign.holdUntilMs > nowMs) {
    return t("updates.campaign.held", {
      time: formatCountdown(campaign.holdUntilMs, nowMs),
    });
  }
  if (campaign.state === "waiting-for-idle") {
    return t("updates.campaign.waitingForIdle", {
      time: formatCountdown(campaign.forceAtMs, nowMs),
    });
  }
  return t("updates.campaign.countdown", {
    time: formatCountdown(campaign.applyAtMs ?? campaign.forceAtMs, nowMs),
  });
}

export function getUpdateGitComparison(
  schedule: UpdateScheduleState | null | undefined,
  updateAvailable: UpdateAvailable | null | undefined,
): {
  currentSha?: string;
  upstreamSha?: string;
  repositoryUrl?: string;
  commitsBehind?: number | false;
} | null {
  const target = schedule?.target;
  if (target?.kind === "package" || schedule?.install?.kind === "package") {
    return null;
  }
  const git = schedule?.install?.git;
  if (schedule?.campaign && target?.kind === "git") {
    // update.run adopts this frozen campaign, even after upstream advances.
    const currentSha =
      updateAvailable?.upstreamSha === target.upstreamSha &&
      (!git?.currentSha || git.currentSha === updateAvailable.currentSha)
        ? updateAvailable.currentSha
        : undefined;
    return {
      upstreamSha: target.upstreamSha,
      ...(currentSha
        ? {
            currentSha,
            repositoryUrl: updateAvailable?.repositoryUrl,
            commitsBehind: updateAvailable?.commitsBehind,
          }
        : {}),
    };
  }
  if (git && git.status !== "unavailable") {
    return {
      currentSha: git.currentSha,
      upstreamSha: git.upstreamSha,
      repositoryUrl: git.repositoryUrl,
      commitsBehind: "commitsBehind" in git ? git.commitsBehind : false,
    };
  }
  if (updateAvailable?.upstreamSha || updateAvailable?.commitsBehind !== undefined) {
    return updateAvailable;
  }
  return target?.kind === "git"
    ? { upstreamSha: target.upstreamSha, commitsBehind: target.commitsBehind }
    : null;
}

/** Campaign targets and checkout comparisons keep their own revision/distance snapshot. */
export function formatUpdateTargetLabel(
  schedule: UpdateScheduleState | null | undefined,
  updateAvailable: UpdateAvailable | null | undefined,
): string | null {
  const target = schedule?.target;
  const comparison = getUpdateGitComparison(schedule, updateAvailable);
  if (comparison) {
    const commitsBehind = comparison.commitsBehind;
    return typeof commitsBehind === "number"
      ? t(commitsBehind === 1 ? "updates.target.commitBehind" : "updates.target.commitsBehind", {
          count: String(commitsBehind),
        })
      : null;
  }
  const version = target?.kind === "package" ? target.version : updateAvailable?.latestVersion;
  return version ? t("updates.target.version", { version }) : null;
}

export function getUpdateGitRevisions(
  schedule: UpdateScheduleState | null | undefined,
  updateAvailable: UpdateAvailable | null | undefined,
): { currentSha?: string; targetSha: string; compareUrl?: string } | null {
  const comparison = getUpdateGitComparison(schedule, updateAvailable);
  if (!comparison?.upstreamSha || comparison.commitsBehind === false) {
    return null;
  }
  const { currentSha, upstreamSha: targetSha, repositoryUrl } = comparison;
  const compareUrl =
    repositoryUrl &&
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/u.test(repositoryUrl) &&
    currentSha &&
    /^[a-f\d]{7,40}$/iu.test(currentSha) &&
    /^[a-f\d]{7,40}$/iu.test(targetSha)
      ? `${repositoryUrl}/compare/${currentSha}...${targetSha}`
      : undefined;
  return { currentSha, targetSha, compareUrl };
}

export function isUpdateActionable(
  updateAvailable: UpdateAvailable | null | undefined,
  updateSchedule: UpdateScheduleState | null | undefined,
  updateBusy: boolean,
): boolean {
  const commitsBehind = getUpdateGitComparison(updateSchedule, updateAvailable)?.commitsBehind;
  return Boolean(
    updateBusy ||
    updateSchedule?.campaign ||
    (commitsBehind !== false &&
      (updateAvailable?.latestVersion !== updateAvailable?.currentVersion || commitsBehind)),
  );
}
