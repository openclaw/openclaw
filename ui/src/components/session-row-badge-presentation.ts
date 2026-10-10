// Deep import on purpose: the protocol barrel carries typebox and every
// schema, which must stay out of the Control UI startup bundle.
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type {
  SessionPlacementDiskSpace,
  SessionPlacementMachine,
} from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { sessionMachineParts } from "./session-machine.ts";

export type SessionPlacementState = NonNullable<GatewaySessionRow["placement"]>["state"];

export { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";

function formatSessionPullRequestSummary(
  summary: SessionCatalogPullRequestSummary,
  translate: typeof t,
): string {
  const numbers = summary.numbers.map((number) => `#${number}`).join(", ");
  return `${numbers} · ${translate(`chat.pullRequests.${summary.state}`)}`;
}

export type SessionRowBadgesParams = {
  isChild?: boolean;
  incognito?: boolean;
  pullRequest?: SessionCatalogPullRequestSummary;
  hasApproval?: boolean;
  outboxAttentionCount?: number;
  hasComposerDraft?: boolean;
  placementState?: SessionPlacementState;
  placementProviderId?: string;
  placementProfileId?: string;
  placementMachine?: SessionPlacementMachine;
  diskSpaceStatus?: SessionPlacementDiskSpace["status"];
  workspaceConflictCount?: number;
};

export type SessionRowBadge = {
  label: string;
  icon: "lock" | "gitMerge" | "gitPullRequest" | "alertTriangle" | "pencil" | "globe";
  modifier: string;
  count?: number;
  pullRequestState?: SessionCatalogPullRequestSummary["state"];
  placementState?: SessionPlacementState;
  diskSpaceStatus?: SessionPlacementDiskSpace["status"];
  workspaceConflictCount?: number;
};

export function resolveSessionRowBadges(
  params: SessionRowBadgesParams,
  translate = t,
): SessionRowBadge[] {
  const pullRequestLabel = params.pullRequest
    ? formatSessionPullRequestSummary(params.pullRequest, translate)
    : undefined;
  const pullRequestState = params.pullRequest?.state;
  const placementState = params.isChild ? undefined : params.placementState;
  const cloudPlacementState = isCloudWorkerPlacementState(placementState)
    ? placementState
    : undefined;
  const workspaceConflictCount = Math.max(0, Math.floor(params.workspaceConflictCount ?? 0));
  // Child rows suppress ordinary placement chrome, but a retained conflict must stay discoverable.
  const conflictPlacementState = workspaceConflictCount > 0 ? params.placementState : undefined;
  const displayedPlacementState = cloudPlacementState ?? conflictPlacementState;
  const hasWorkspaceConflict = workspaceConflictCount > 0;
  const diskSpaceStatus = params.isChild ? undefined : params.diskSpaceStatus;
  const diskSpaceLabel =
    diskSpaceStatus === "critical"
      ? translate("sessionsView.cloudWorkerDiskCritical")
      : diskSpaceStatus === "warning"
        ? translate("sessionsView.cloudWorkerDiskWarning")
        : "";
  const attentionCount = Math.max(0, Math.floor(params.outboxAttentionCount ?? 0));
  const attentionLabel =
    attentionCount > 0
      ? translate(
          attentionCount === 1
            ? "sessionsView.messageNeedsAttention"
            : "sessionsView.messagesNeedAttention",
          {
            count: String(attentionCount),
          },
        )
      : "";
  if (
    !params.incognito &&
    !pullRequestLabel &&
    !params.hasApproval &&
    attentionCount === 0 &&
    !params.hasComposerDraft &&
    !displayedPlacementState &&
    !hasWorkspaceConflict
  ) {
    return [];
  }
  const placementLabel = displayedPlacementState
    ? params.placementProviderId && params.placementProfileId
      ? [
          params.placementProviderId,
          params.placementProfileId,
          ...sessionMachineParts(params.placementMachine),
          displayedPlacementState,
        ]
          .filter(Boolean)
          .join(" · ")
      : translate("sessionsView.cloudWorkerPlacement", { state: displayedPlacementState })
    : "";
  const cloudPlacementLabel = hasWorkspaceConflict
    ? displayedPlacementState
      ? translate(
          workspaceConflictCount === 1
            ? "sessionsView.placementWorkspaceConflict"
            : "sessionsView.placementWorkspaceConflicts",
          {
            placement: placementLabel,
            count: String(workspaceConflictCount),
          },
        )
      : translate(
          workspaceConflictCount === 1
            ? "sessionsView.cloudWorkerDescendantConflict"
            : "sessionsView.cloudWorkerDescendantConflicts",
          { count: String(workspaceConflictCount) },
        )
    : placementLabel;
  const cloudLabel = [cloudPlacementLabel, diskSpaceLabel].filter(Boolean).join(" · ");
  const badges: SessionRowBadge[] = [];
  if (params.incognito) {
    badges.push({
      label: translate("sessionsView.incognito"),
      icon: "lock",
      modifier: "incognito",
    });
  }
  if (pullRequestLabel) {
    badges.push({
      label: pullRequestLabel,
      icon: pullRequestState === "merged" ? "gitMerge" : "gitPullRequest",
      modifier: "pull-request",
      pullRequestState,
    });
  }
  if (params.hasApproval) {
    badges.push({
      label: translate("sessionsView.approvalNeeded"),
      icon: "alertTriangle",
      modifier: "approval",
    });
  }
  if (attentionCount > 0) {
    badges.push({
      label: attentionLabel,
      icon: "alertTriangle",
      modifier: "attention",
      count: attentionCount,
    });
  }
  if (params.hasComposerDraft) {
    badges.push({
      label: translate("sessionsView.unsentDraft"),
      icon: "pencil",
      modifier: "draft",
    });
  }
  if (displayedPlacementState || hasWorkspaceConflict) {
    badges.push({
      label: cloudLabel,
      icon: "globe",
      modifier: "cloud",
      placementState: displayedPlacementState,
      diskSpaceStatus,
      workspaceConflictCount,
    });
  }
  return badges;
}
