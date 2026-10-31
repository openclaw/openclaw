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
import { sessionPullRequestStateIcons } from "../lib/session-pull-request-presentation.ts";
import type { SessionPullRequestIndicators } from "./app-sidebar-session-pr-indicators.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sessionMachineParts } from "./session-machine.ts";

export function sidebarSessionBadgeFacts(
  source: Pick<SessionPullRequestIndicators, "summary" | "count">,
  row: SidebarRecentSession,
  initialPullRequest = row.pullRequest,
) {
  const attention = row.attention;
  return (
    row.snapshot ?? {
      // An approval the leading icon already shows needs no second badge; a question
      // carrying approval requests leads with the question, so the badge adds the approval.
      hasApproval:
        (attention.kind === "question" &&
          attention.requests.some((request) => request.kind === "approval")) ||
        undefined,
      pullRequest: source.summary(row.key, row.worktreeId ?? "", initialPullRequest),
      pullRequestCount: source.count(row.key),
    }
  );
}

type SessionPlacementState = NonNullable<GatewaySessionRow["placement"]>["state"];

export { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";

export type SessionRowBadgesParams = {
  isChild?: boolean;
  incognito?: boolean;
  pullRequest?: SessionCatalogPullRequestSummary;
  pullRequestCount?: number;
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
  icon:
    | "incognito"
    | "gitMerge"
    | "gitPullRequest"
    | "gitPullRequestDraft"
    | "gitPullRequestClosed"
    | "alertTriangle"
    | "pencil"
    | "globe";
  modifier: string;
  count?: number;
  countLabel?: string;
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
    ? `${params.pullRequest.numbers.map((number) => `#${number}`).join(", ")} · ${translate(`chat.pullRequests.${params.pullRequest.state}`)}`
    : undefined;
  const pullRequestState = params.pullRequest?.state;
  const placementState = params.isChild ? undefined : params.placementState;
  // A healthy or settling worker is the expected state; the row shows placement
  // only when it failed, runs low on disk, or holds workspace conflicts.
  const cloudPlacementState =
    isCloudWorkerPlacementState(placementState) &&
    (placementState === "failed" ||
      params.diskSpaceStatus === "warning" ||
      params.diskSpaceStatus === "critical")
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
      icon: "incognito",
      modifier: "incognito",
    });
  }
  if (params.pullRequest || params.pullRequestCount) {
    const count = params.pullRequestCount ?? params.pullRequest?.numbers.length ?? 0;
    badges.push({
      label: [
        count > 1 || !pullRequestLabel
          ? translate("sessionsView.pullRequestCount", { count: String(count) })
          : "",
        pullRequestLabel,
      ]
        .filter(Boolean)
        .join(" · "),
      icon: params.pullRequest
        ? sessionPullRequestStateIcons[params.pullRequest.state]
        : "gitPullRequest",
      modifier: "pull-request",
      pullRequestState,
      count: count > 1 ? count : undefined,
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
  return trimSessionRowBadges(badges);
}

// The trailing column holds two context signals at most. Badges asking for action
// outrank passive context; the survivors keep their reading order.
const SESSION_ROW_BADGE_LIMIT = 2;
const SESSION_ROW_BADGE_PRIORITY = [
  "attention",
  "approval",
  "cloud",
  "draft",
  "pull-request",
  "incognito",
];
const SESSION_ROW_COUNT_LIMIT = 99;

function trimSessionRowBadges(badges: SessionRowBadge[]): SessionRowBadge[] {
  const rank = (modifier: string) => SESSION_ROW_BADGE_PRIORITY.indexOf(modifier);
  const kept = new Set(
    badges
      .map((badge) => badge.modifier)
      .toSorted((a, b) => rank(a) - rank(b))
      .slice(0, SESSION_ROW_BADGE_LIMIT),
  );
  const visible = badges.filter((badge) => kept.has(badge.modifier));
  for (const badge of visible) {
    if ((badge.count ?? 0) > SESSION_ROW_COUNT_LIMIT) {
      badge.count = undefined;
      badge.countLabel = `${SESSION_ROW_COUNT_LIMIT}+`;
    }
  }
  return visible;
}
