import { html, nothing, type TemplateResult } from "lit";
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
import { icons } from "./icons.ts";
import { sessionMachineParts } from "./session-machine.ts";

export type SessionPlacementState = NonNullable<GatewaySessionRow["placement"]>["state"];

export { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";

function formatSessionPullRequestSummary(summary: SessionCatalogPullRequestSummary): string {
  const numbers = summary.numbers.map((number) => `#${number}`).join(", ");
  return `${numbers} · ${t(`chat.pullRequests.${summary.state}`)}`;
}

function renderSessionRowBadge(
  label: string | false | undefined,
  icon: TemplateResult,
  modifier: string,
  options: {
    count?: number;
    pullRequestState?: SessionCatalogPullRequestSummary["state"];
    placementState?: SessionPlacementState;
    diskSpaceStatus?: SessionPlacementDiskSpace["status"];
    workspaceConflictCount?: number;
  } = {},
) {
  if (label === false || label === undefined) {
    return nothing;
  }
  const {
    count = 0,
    pullRequestState,
    placementState,
    diskSpaceStatus,
    workspaceConflictCount = 0,
  } = options;
  return html`<openclaw-tooltip .content=${label}>
    <span
      class=${`session-row-badge session-row-badge--${modifier}`}
      data-pull-request-state=${pullRequestState ?? nothing}
      data-placement-state=${placementState ?? nothing}
      data-disk-space-status=${diskSpaceStatus ?? nothing}
      data-workspace-conflicts=${workspaceConflictCount ? String(workspaceConflictCount) : nothing}
      role="img"
      aria-label=${label}
      >${icon}${count ? html`<span aria-hidden="true">${count}</span>` : nothing}</span
    >
  </openclaw-tooltip>`;
}

export function renderSessionRowBadges(params: {
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
}) {
  const pullRequestLabel = params.pullRequest
    ? formatSessionPullRequestSummary(params.pullRequest)
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
      ? t("sessionsView.cloudWorkerDiskCritical")
      : diskSpaceStatus === "warning"
        ? t("sessionsView.cloudWorkerDiskWarning")
        : "";
  const attentionCount = Math.max(0, Math.floor(params.outboxAttentionCount ?? 0));
  const attentionLabel =
    attentionCount > 0
      ? t(
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
    return nothing;
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
      : t("sessionsView.cloudWorkerPlacement", { state: displayedPlacementState })
    : "";
  const cloudPlacementLabel = hasWorkspaceConflict
    ? displayedPlacementState
      ? t(
          workspaceConflictCount === 1
            ? "sessionsView.placementWorkspaceConflict"
            : "sessionsView.placementWorkspaceConflicts",
          {
            placement: placementLabel,
            count: String(workspaceConflictCount),
          },
        )
      : t(
          workspaceConflictCount === 1
            ? "sessionsView.cloudWorkerDescendantConflict"
            : "sessionsView.cloudWorkerDescendantConflicts",
          { count: String(workspaceConflictCount) },
        )
    : placementLabel;
  const cloudLabel = [cloudPlacementLabel, diskSpaceLabel].filter(Boolean).join(" · ");
  return html`<span class="session-row-badges">
    ${renderSessionRowBadge(params.incognito && t("sessionsView.incognito"), icons.lock, "incognito")}
    ${renderSessionRowBadge(
      pullRequestLabel || undefined,
      pullRequestState === "merged" ? icons.gitMerge : icons.gitPullRequest,
      "pull-request",
      { pullRequestState },
    )}
    ${renderSessionRowBadge(params.hasApproval && t("sessionsView.approvalNeeded"), icons.alertTriangle, "approval")}
    ${renderSessionRowBadge(attentionCount > 0 && attentionLabel, icons.alertTriangle, "attention", { count: attentionCount })}
    ${renderSessionRowBadge(params.hasComposerDraft && t("sessionsView.unsentDraft"), icons.pencil, "draft")}
    ${renderSessionRowBadge(
      Boolean(displayedPlacementState || hasWorkspaceConflict) && cloudLabel,
      icons.globe,
      "cloud",
      { placementState: displayedPlacementState, diskSpaceStatus, workspaceConflictCount },
    )}
  </span>`;
}
