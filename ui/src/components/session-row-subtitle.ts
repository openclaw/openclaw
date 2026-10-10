import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../i18n/index.ts";
import { resolveToolDisplayIcon } from "../lib/chat/tool-display-icon.ts";
import { isCriticalObserverHealth, pickFreshestObserverDigest } from "../lib/observer-digest.ts";
import type { SidebarRecentSession, SidebarToolActivity } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { sessionAttentionSubtitle } from "./session-attention-presentation.ts";

type SidebarSessionSubtitle = {
  subtitle: string | undefined;
  narration: string | undefined;
  toolName?: string;
};

/** Resolves the single subtitle slot without displacing visible status. */
export function resolveSidebarSessionSubtitle(params: {
  session: SidebarRecentSession;
  hasDisplay: boolean;
  sidebarLiveActivity: boolean;
  showPreview: boolean;
  narrationLine: string | undefined;
  toolActivity?: SidebarToolActivity;
  observerDigest?: Pick<
    SessionObserverDigest,
    "agentId" | "runId" | "headline" | "health" | "updatedAt" | "revision"
  > | null;
}): SidebarSessionSubtitle {
  const { session } = params;
  // Questions use the leading hand tooltip; failures use the session hovercard.
  // Neither should grow a second line or fall back to lower-priority activity.
  if (session.attention.kind === "question" || session.attention.kind === "error") {
    return { subtitle: undefined, narration: undefined };
  }
  const attention = sessionAttentionSubtitle(session.attention);
  const running = session.hasActiveRun;
  const activeRunIds = session.activeRunIds ?? [];
  const digestMatchesActiveRun = (
    digest: typeof params.observerDigest,
  ): digest is NonNullable<typeof digest> =>
    Boolean(digest?.runId && activeRunIds.includes(digest.runId));
  const liveCandidate = digestMatchesActiveRun(params.observerDigest)
    ? params.observerDigest
    : undefined;
  const rowCandidate = digestMatchesActiveRun(session.observerDigest)
    ? session.observerDigest
    : undefined;
  const projectedDigest = running
    ? pickFreshestObserverDigest(liveCandidate, rowCandidate)
    : pickFreshestObserverDigest(params.observerDigest, session.observerDigest);
  const finalDigestUnread = Boolean(
    projectedDigest &&
    (projectedDigest.health === "done" || projectedDigest.health === "failed") &&
    (session.lastReadAt ?? 0) < projectedDigest.updatedAt,
  );
  const observer = running || finalDigestUnread ? projectedDigest?.headline : undefined;
  // Preview off hides ambient text only. Subtitle-owned attention and a critical
  // observer headline survive the toggle: pending approvals and the
  // stuck / waiting-on-user health states still belong beside their session, even
  // when the operator hides routine activity previews.
  if (!params.showPreview) {
    const critical = isCriticalObserverHealth(projectedDigest?.health) ? observer : undefined;
    return { subtitle: attention ?? critical, narration: undefined };
  }
  // Agent-declared status (sessions tool) outranks live narration: it is an
  // explicit message to the user, not ambient activity.
  const agentStatus = session.agentStatusNote || undefined;
  if (
    running &&
    params.sidebarLiveActivity &&
    params.toolActivity?.text &&
    !attention &&
    !agentStatus &&
    !isCriticalObserverHealth(projectedDigest?.health)
  ) {
    const { name, text } = params.toolActivity;
    return { subtitle: text, narration: undefined, toolName: name };
  }
  const narration =
    attention || agentStatus || observer || !params.sidebarLiveActivity || !running
      ? undefined
      : params.narrationLine;
  const workSubtitle =
    !params.hasDisplay &&
    session.subtitle &&
    session.workSession &&
    session.subtitle !== session.label
      ? session.subtitle
      : undefined;
  const finalReply =
    !running && !params.hasDisplay ? session.lastMessagePreview?.trim() || undefined : undefined;
  const subtitle = attention ?? agentStatus ?? observer ?? narration ?? finalReply ?? workSubtitle;
  return { subtitle, narration };
}

export function renderSidebarSessionSubtitle(value: SidebarSessionSubtitle) {
  if (!value.subtitle) {
    return nothing;
  }
  const label = value.toolName ? `${t("chat.toolCards.tool")}: ${value.toolName}` : undefined;
  const icon = value.toolName
    ? html`<openclaw-tooltip .content=${label} .describe=${false}
        ><span class="sidebar-session-tool" role="img" aria-label=${label}
          >${icons[resolveToolDisplayIcon(value.toolName)]}</span
        ></openclaw-tooltip
      >`
    : nothing;
  const text = value.narration
    ? keyed(
        value.narration,
        html`<span
          class="sidebar-recent-session__subtitle sidebar-recent-session__subtitle--narration"
          >${value.subtitle}</span
        >`,
      )
    : html`<span class="sidebar-recent-session__subtitle">${value.subtitle}</span>`;
  return html`${icon}${text}`;
}
