import { html, nothing } from "lit";
import { icons } from "./icons.ts";
import {
  resolveSessionRowBadges,
  type SessionRowBadgesParams,
} from "./session-row-badge-presentation.ts";
export {
  isCloudWorkerPlacementState,
  type SessionPlacementState,
} from "./session-row-badge-presentation.ts";

export function renderSessionRowBadges(params: SessionRowBadgesParams) {
  const badges = resolveSessionRowBadges(params);
  return badges.length
    ? html`<span class="session-row-badges"
        >${badges.map(
          (badge) => html`<openclaw-tooltip .content=${badge.label}>
            <span
              class=${`session-row-badge session-row-badge--${badge.modifier}`}
              data-pull-request-state=${badge.pullRequestState ?? nothing}
              data-placement-state=${badge.placementState ?? nothing}
              data-disk-space-status=${badge.diskSpaceStatus ?? nothing}
              data-workspace-conflicts=${badge.workspaceConflictCount ? String(badge.workspaceConflictCount) : nothing}
              role="img"
              aria-label=${badge.label}
              >${icons[badge.icon]}${badge.count ? html`<span aria-hidden="true">${badge.count}</span>` : nothing}</span
            >
          </openclaw-tooltip>`,
        )}</span
      >`
    : nothing;
}
