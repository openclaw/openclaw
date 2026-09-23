import type { ProgressCard } from "@openclaw/gateway-protocol";
import { bucketRelativeTimeMs, type RelativeTimeUnit } from "@openclaw/normalization-core";
import { html, nothing } from "lit";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { i18n, t } from "../i18n/index.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  personActivityLink,
  renderPersonAvatarLink,
  renderPersonName,
  type PersonActivityRouting,
} from "./person-activity-link.ts";
import { renderSessionColorDot } from "./session-color.ts";
import {
  renderSessionHovercardContext,
  type SessionHovercardContextInput,
} from "./session-hovercard-context.ts";
import { renderSessionOwnerChip } from "./session-owner-chip.ts";
import { progressCardHeadsUp, renderProgressCardMarkdown } from "./session-progress-card.ts";
import "./session-hovercard.css";
import "./tooltip.ts";
import "./viewer-facepile.ts";

// Preserve the pre-dropdown facepile footprint; further identities remain linked in the menu.
const MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS = 4;

function participantLabel(participant: SessionParticipant): string {
  return participant.label?.trim() || participant.identity.id;
}

type SessionAgeUnit = RelativeTimeUnit | "week" | "month" | "year";

type SessionHovercardInput = SessionHovercardContextInput & {
  avatarAuth?: { authTokens: readonly string[]; authReady: boolean };
  personActivity?: PersonActivityRouting;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  progressCard?: ProgressCard | null;
};

function pullRequestStateLabel(state: ControlUiSessionPullRequest["state"]): string {
  return t(`sessionHovercard.states.${state}`);
}

function checksLabel(checks: NonNullable<ControlUiSessionPullRequest["checks"]>): string {
  switch (checks.state) {
    case "passing":
      return t("sessionHovercard.checks.passing");
    case "failing":
      return t("sessionHovercard.checks.failing");
    case "pending":
      return t("sessionHovercard.checks.pending");
    default:
      return checks.state satisfies never;
  }
}

function pullRequestStateIcon(state: ControlUiSessionPullRequest["state"]) {
  switch (state) {
    case "open":
      return icons.gitPullRequest;
    case "draft":
      return icons.gitPullRequestDraft;
    case "merged":
      return icons.gitMerge;
    case "closed":
      return icons.gitPullRequestClosed;
    default:
      return state satisfies never;
  }
}

function renderDiffStats(item: { additions?: number; deletions?: number }) {
  if (item.additions === undefined && item.deletions === undefined) {
    return nothing;
  }
  return html`<span class="session-hovercard__diff">
    ${
      item.additions === undefined
        ? nothing
        : html`<span class="session-hovercard__additions"
            >+${item.additions.toLocaleString()}</span
          >`
    }
    ${
      item.deletions === undefined
        ? nothing
        : html`<span class="session-hovercard__deletions"
            >−${item.deletions.toLocaleString()}</span
          >`
    }
  </span>`;
}

function sessionAgeBucket(diffMs: number): { value: number; unit: SessionAgeUnit } {
  const days = Math.abs(diffMs) / (24 * 60 * 60_000);
  if (days >= 365) {
    return { value: Math.max(1, Math.round(days / 365)), unit: "year" };
  }
  if (days >= 28) {
    return { value: Math.max(1, Math.round(days / 30)), unit: "month" };
  }
  if (days >= 7) {
    return { value: Math.max(1, Math.round(days / 7)), unit: "week" };
  }
  if (days >= 1) {
    return { value: Math.max(1, Math.round(days)), unit: "day" };
  }
  return bucketRelativeTimeMs(Math.abs(diffMs));
}

function formatSessionAge(timestamp: number | null | undefined, suffix: boolean): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return "";
  }
  const diff = timestamp - Date.now();
  const { value, unit } = sessionAgeBucket(diff);
  if (suffix) {
    if (unit === "second" && diff <= 0) {
      return t("common.justNow");
    }
    return new Intl.RelativeTimeFormat(i18n.getLocale(), {
      numeric: "always",
      style: "narrow",
    }).format(diff <= 0 ? -value : value, unit);
  }
  if (i18n.getLocale().toLowerCase().startsWith("en")) {
    const compactSuffix: Partial<Record<SessionAgeUnit, string>> = {
      second: "s",
      minute: "m",
      hour: "h",
      day: "d",
      week: "w",
      month: "mo",
      year: "y",
    };
    const unitSuffix = compactSuffix[unit];
    if (unitSuffix) {
      return `${value}${unitSuffix}`;
    }
  }
  return new Intl.NumberFormat(i18n.getLocale(), {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: 0,
  }).format(value);
}

function sessionAttribution(row: SidebarSessionHovercardRow) {
  const seen = new Set<string>();
  const participants = (row.expandedParticipants ?? row.participants ?? []).filter(
    (participant) => {
      const key = JSON.stringify(participant.identity);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    },
  );
  const primary = participants[0];
  if (!primary) {
    return undefined;
  }
  return {
    primaryIdentity: primary.identity,
    primaryLabel: participantLabel(primary),
    participants,
    otherCount: Math.max(participants.length, row.participantCount ?? 0) - 1,
  };
}

function renderSessionOwner(row: SidebarSessionHovercardRow) {
  const owner = row.owner?.actor;
  if (!owner?.id) {
    return nothing;
  }
  return html`<div class="session-hovercard__owner">
    <span class="session-hovercard__attribution-label">${t("sessionsView.owner")}</span>
    ${renderSessionOwnerChip(owner, "header", "owned")}
    <span class="session-hovercard__owner-name">${owner.label || owner.id}</span>
  </div>`;
}

function renderParticipantMenu(
  participants: readonly SessionParticipant[],
  participantCount: number,
  personActivity: PersonActivityRouting | undefined,
) {
  const unresolvedCount = Math.max(0, participantCount - participants.length);
  return html`<div
    slot="content"
    class="session-hovercard__participant-menu"
    role="list"
    style="min-width: 150px; max-height: min(280px, 60vh); overflow-y: auto;"
    aria-label=${t("sessionHovercard.moreParticipantsLabel", {
      count: String(participantCount),
    })}
  >
    ${participants.map((participant) => {
      const label = participantLabel(participant);
      const activity =
        participant.identity.type === "profile"
          ? personActivityLink(participant.identity.id, personActivity, label)
          : null;
      return html`<div role="listitem">
        ${renderPersonName(
          label,
          activity,
          "session-menu__item learn-more-link session-hovercard__participant-link",
        )}
      </div>`;
    })}
    ${
      unresolvedCount > 0
        ? html`<div class="session-hovercard__more" role="listitem">
            ${t("sessionHovercard.moreParticipantsLabel", { count: String(unresolvedCount) })}
          </div>`
        : nothing
    }
  </div>`;
}

function renderSessionAttribution({ row, personActivity }: SessionHovercardInput) {
  if (!row) {
    return nothing;
  }
  const attribution = sessionAttribution(row);
  if (!attribution) {
    return nothing;
  }
  const { primaryIdentity, primaryLabel, participants, otherCount } = attribution;
  const primaryParticipant = participants[0];
  const primaryActivity =
    primaryIdentity?.type === "profile"
      ? personActivityLink(primaryIdentity.id, personActivity, primaryLabel)
      : null;
  const primaryAvatar = primaryParticipant
    ? html`<openclaw-viewer-avatar
        class="session-hovercard__participant-avatar"
        .user=${{
          id: primaryParticipant.identity.id,
          name: primaryParticipant.label,
          avatarUrl: primaryParticipant.avatarUrl,
          watchedSessions: [],
        }}
        .markAsViewer=${false}
        .identity=${primaryParticipant.identity}
        variant="session"
        aria-hidden="true"
      ></openclaw-viewer-avatar>`
    : nothing;
  const remainingParticipants = participants.slice(1);
  const attributionLabel = [
    primaryLabel,
    otherCount > 0
      ? t("sessionHovercard.moreParticipantsLabel", { count: String(otherCount) })
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const otherLabel =
    otherCount > 0
      ? t(
          otherCount === 1
            ? "sessionHovercard.attributionOther"
            : "sessionHovercard.attributionOthers",
          { count: String(otherCount) },
        )
      : "";
  return html`<div class="session-hovercard__participants">
    <span class="session-hovercard__attribution-label"
      >${t("sessionHovercard.sessionParticipants")}</span
    >
    <div class="session-hovercard__attribution" aria-label=${attributionLabel}>
      <span class="session-hovercard__attribution-copy">
        ${renderPersonName(primaryLabel, primaryActivity, "session-hovercard__attribution-name")}
        ${
          otherCount > 0
            ? remainingParticipants.length > 0
              ? html`<openclaw-tooltip
                  class="session-hovercard__participants-tooltip"
                  .describe=${false}
                  open-on-click
                >
                  <button
                    type="button"
                    class="session-hovercard__attribution-others"
                    style="padding: 1px 3px; border: 0; border-radius: var(--radius-sm); background: transparent; font: inherit;"
                    aria-label=${t("sessionHovercard.moreParticipantsLabel", {
                      count: String(otherCount),
                    })}
                  >
                    ${otherLabel}
                  </button>
                  ${renderParticipantMenu(remainingParticipants, otherCount, personActivity)}
                </openclaw-tooltip>`
              : html`<span class="session-hovercard__attribution-others">${otherLabel}</span>`
            : nothing
        }
      </span>
      <span class="session-hovercard__attribution-avatars">
        ${renderPersonAvatarLink(primaryAvatar, primaryActivity)}
        ${
          remainingParticipants.length > 0
            ? html`<openclaw-viewer-facepile
                .staticParticipants=${remainingParticipants}
                .totalCount=${otherCount}
                .maxVisible=${Math.min(
                  remainingParticipants.length,
                  MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS,
                )}
                .personActivity=${personActivity}
              ></openclaw-viewer-facepile>`
            : nothing
        }
      </span>
    </div>
  </div>`;
}

let channelAvatarElementLoad: Promise<unknown> | undefined;
function renderChannelAvatar(input: SessionHovercardInput) {
  if (!input.row?.channelAvatarUrl) {
    return nothing;
  }
  channelAvatarElementLoad ??= import("./channel-avatar.ts");
  return html`<openclaw-channel-avatar
    class="session-hovercard__channel-avatar"
    .routeUrl=${input.row.channelAvatarUrl}
    .authTokens=${input.avatarAuth?.authTokens ?? []}
    .authReady=${input.avatarAuth?.authReady ?? false}
    .fallback=${icons.link}
    aria-hidden="true"
  ></openclaw-channel-avatar>`;
}

function renderHeader(input: SessionHovercardInput) {
  const row = input.row!;
  const channel = row.channelPresentation;
  const details = channel
    ? [
        ...new Set(
          [channel.conversation, channel.address].filter((value) => value && value !== row.label),
        ),
      ]
    : [];
  const hasCreatedAt = typeof row.createdAt === "number" && Number.isFinite(row.createdAt);
  const created = hasCreatedAt ? formatSessionAge(row.createdAt, true) : "";
  const age = hasCreatedAt ? formatSessionAge(row.createdAt, false) : "";
  return html`<header class="session-hovercard__header">
    <span class="session-hovercard__heading">
      ${
        channel
          ? html`<span class="session-hovercard__channel"
              ><span aria-hidden="true">${icons.link}</span
              >${t("sessionHovercard.linkedChannel", { channel: channel.channelLabel })}</span
            >`
          : nothing
      }
      <span class="session-hovercard__title"
        >${renderChannelAvatar(input)}${renderSessionColorDot(row.color)}${row.label}</span
      >
      ${renderSessionOwner(row)}
      ${
        channel
          ? html`<span class="session-hovercard__conversation">
              ${channel.kind ? html`<span>${channel.topicId ? t("sessionHovercard.topicNumber", { id: channel.topicId }) : t(`sessionHovercard.chatKinds.${channel.kind}`)}</span>` : nothing}
              ${details.map((detail) => html`<span>${detail}</span>`)}
              ${channel.account ? html`<span>${t("sessionHovercard.viaAccount", { account: channel.account })}</span>` : nothing}
            </span>`
          : renderSessionAttribution(input)
      }
    </span>
    ${
      age
        ? html`<span class="session-hovercard__created-age" title=${created}>${age}</span>`
        : nothing
    }
  </header>`;
}

function renderAgentNotepad(card: ProgressCard | null | undefined) {
  if (!card?.markdown?.trim()) {
    return nothing;
  }
  return html`<section
    class="session-hovercard__section session-hovercard__notepad"
    aria-label=${t("sessionHovercard.agentNotepad")}
  >
    <div class="session-hovercard__notepad-title">${t("sessionHovercard.agentNotepad")}</div>
    ${renderProgressCardMarkdown(card.markdown, { promoteProgress: true })}
  </section>`;
}

function renderPullRequestRow(pullRequest: ControlUiSessionPullRequest) {
  const state = pullRequestStateLabel(pullRequest.state);
  const checks = pullRequest.checks ? checksLabel(pullRequest.checks) : null;
  const details = [
    pullRequest.title,
    checks,
    pullRequest.additions === undefined ? null : `+${pullRequest.additions.toLocaleString()}`,
    pullRequest.deletions === undefined ? null : `−${pullRequest.deletions.toLocaleString()}`,
  ].filter((detail): detail is string => Boolean(detail));
  return html`<a
    class="session-hovercard__pr-row"
    data-state=${pullRequest.state}
    href=${pullRequest.url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label=${`${t("sessionHovercard.pullRequestLabel", {
      number: String(pullRequest.number),
      state,
    })}${details.length > 0 ? `, ${details.join(", ")}` : ""}`}
  >
    <span
      class="session-hovercard__pr-state-icon"
      role="img"
      data-checks=${pullRequest.checks?.state ?? nothing}
      aria-label=${checks ? `${state} · ${checks}` : state}
      title=${checks ? `${state} · ${checks}` : state}
      >${pullRequestStateIcon(pullRequest.state)}</span
    >
    <span class="session-hovercard__pr-title">${pullRequest.title}</span>
    ${renderDiffStats(pullRequest)}
  </a>`;
}

function renderPullRequestDetails(snapshot: ControlUiSessionPullRequestSnapshot | undefined) {
  if (!snapshot) {
    return nothing;
  }
  if (snapshot.pullRequests.length > 0) {
    const visible = snapshot.pullRequests.slice(0, 1);
    const hiddenCount = snapshot.pullRequests.length - visible.length;
    return html`<div class="session-hovercard__pr-list">
      ${visible.map(renderPullRequestRow)}
      ${
        hiddenCount > 0
          ? html`<span class="session-hovercard__more"
              >${t("sessionHovercard.more", { count: String(hiddenCount) })}</span
            >`
          : nothing
      }
    </div>`;
  }
  const branch = snapshot.branch;
  if (!branch) {
    return nothing;
  }
  const createPullRequest = t("chat.pullRequests.createPr");
  const createPullRequestLabel = t("chat.pullRequests.createPrLabel", {
    branch: branch.branch,
  });
  return html`<div class="session-hovercard__branch-row">
    <span class="session-hovercard__branch-icon" aria-hidden="true">${icons.gitBranch}</span>
    ${
      branch.createUrl
        ? html`<a
            class="session-hovercard__branch-action"
            href=${branch.createUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label=${createPullRequestLabel}
            title=${createPullRequestLabel}
            >${createPullRequest}</a
          >`
        : html`<span class="session-hovercard__branch-label">${t("chat.sessionDiff.title")}</span>`
    }
    ${renderDiffStats(branch)}
  </div>`;
}

export function renderSessionHovercard(input: SessionHovercardInput) {
  const channelAttribution = input.row?.channelPresentation
    ? renderSessionAttribution(input)
    : nothing;
  const headsUp = progressCardHeadsUp(
    input.progressCard,
    input.row?.status,
    input.row?.startedAt,
    input.row?.hasActiveRun ?? false,
  );
  const hasPullRequestDetails = Boolean(
    input.pullRequests &&
    (input.pullRequests.pullRequests.length > 0 ||
      input.pullRequests.branch ||
      input.pullRequests.status !== "ready"),
  );
  const hasContext = Boolean(
    input.row?.workContext ||
    (input.row?.placementProviderId && input.row.placementProfileId) ||
    input.row?.boardFace === "dashboard" ||
    (input.row?.hasAutomation && input.automationLink) ||
    headsUp,
  );
  const lastMessagePreview = input.progressCard
    ? undefined
    : input.row?.lastMessagePreview?.trim() || undefined;
  if (!input.row && !hasPullRequestDetails && !input.progressCard) {
    return nothing;
  }
  return html`<div class="session-hovercard">
    ${
      input.row
        ? html`<section class="session-hovercard__section session-hovercard__section--header">
            ${renderHeader(input)}
          </section>`
        : nothing
    }
    ${
      hasContext
        ? html`<section class="session-hovercard__section session-hovercard__section--metadata">
            ${renderSessionHovercardContext(input, headsUp)}
          </section>`
        : nothing
    }
    ${
      hasPullRequestDetails
        ? html`<section class="session-hovercard__section session-hovercard__section--prs">
            ${renderPullRequestDetails(input.pullRequests)}
            ${
              input.pullRequests?.status !== "ready"
                ? html`<div class="session-hovercard__more" role="status">
                    ${t(
                      input.pullRequests?.status === "rate-limited"
                        ? "chat.pullRequests.rateLimited"
                        : "chat.pullRequests.unavailable",
                    )}
                  </div>`
                : nothing
            }
          </section>`
        : nothing
    }
    ${
      lastMessagePreview
        ? html`<section class="session-hovercard__section session-hovercard__section--optional">
            <div class="session-hovercard__excerpt">${lastMessagePreview}</div>
          </section>`
        : nothing
    }
    ${renderAgentNotepad(input.progressCard)}
    ${
      channelAttribution !== nothing
        ? html`<section
            class="session-hovercard__section session-hovercard__section--attribution"
            aria-label=${t("sessionHovercard.sessionParticipants")}
          >
            ${channelAttribution}
          </section>`
        : nothing
    }
  </div>`;
}
