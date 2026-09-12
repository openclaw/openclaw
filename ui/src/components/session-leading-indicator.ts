import { html, nothing, type TemplateResult } from "lit";
import type { SessionParticipantIdentity } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { t } from "../i18n/index.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  renderSessionAttentionIcon,
  renderSessionIdleState,
} from "./session-attention-presentation.ts";
import { renderSessionGlyph, renderSessionUnreadBadge } from "./session-glyph.ts";
import { resolveSessionIconGlyph } from "./session-icon-glyph-registry.ts";
import { renderSessionOwnerChip, type SessionCreatedActor } from "./session-owner-chip.ts";

type SessionAvatarAuth = {
  authTokens: readonly string[];
  authReady: boolean;
};

// Channel avatars stay out of the startup bundle (startup-JS budget): the
// element registers on the first avatar row, and the owner-chip fallback
// keeps the lead slot occupied through the one-time upgrade window.
let channelAvatarElementLoad: Promise<unknown> | undefined;
function ensureChannelAvatarElement(): void {
  channelAvatarElementLoad ??= import("./channel-avatar.ts");
}

function renderPersistentSessionIcon(icon: string) {
  const glyph = resolveSessionIconGlyph(icon);
  return glyph
    ? html`<span class="session-glyph__icon" aria-hidden="true">${glyph}</span>`
    : html`<span class="session-glyph__emoji" aria-hidden="true">${icon}</span>`;
}

export function describeSessionState(session: SidebarRecentSession) {
  return [
    !session.isChild && session.forkSource ? t("sessionsView.forkedSession") : "",
    (session.hasActiveRun || session.runningChildCount > 0) && session.unread
      ? t("sessionsView.unread")
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function renderSessionLeadingState(
  session: SidebarRecentSession,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "owned" | "archived",
  ownerViewing?: boolean,
  avatarAuth?: SessionAvatarAuth,
): {
  running: boolean;
  leadingIndicator: TemplateResult | typeof nothing;
  renderedIdentities?: readonly SessionParticipantIdentity[];
} {
  const { participants, participantCount } = session;
  const subagentsWorking = session.runningChildCount > 0;
  const running = session.hasActiveRun || subagentsWorking;
  const ownRunQueued = session.hasActiveRun && session.status === "queued";
  const runState = {
    running,
    queued: ownRunQueued && !subagentsWorking,
    runningLabel:
      subagentsWorking && (!session.hasActiveRun || ownRunQueued)
        ? t("sessionsView.subagentsWorking")
        : undefined,
  };
  // Transient attention always outranks the persistent decorative icon.
  if (session.isChild) {
    if (session.attention.kind !== "none") {
      return {
        running,
        leadingIndicator: renderSessionGlyph({
          content: renderSessionAttentionIcon(session.attention, true),
          ...runState,
          badge: session.unread && !running ? renderSessionUnreadBadge() : nothing,
        }),
      };
    }
    if (session.icon) {
      return {
        running,
        leadingIndicator: renderSessionGlyph({
          content: renderPersistentSessionIcon(session.icon),
          ...runState,
          badge: session.unread && !running ? renderSessionUnreadBadge() : nothing,
        }),
      };
    }
    if (session.channelAvatarUrl) {
      ensureChannelAvatarElement();
      return {
        running,
        leadingIndicator: renderSessionGlyph({
          content: html`<openclaw-channel-avatar
            .routeUrl=${session.channelAvatarUrl}
            .authTokens=${avatarAuth?.authTokens ?? []}
            .authReady=${avatarAuth?.authReady ?? false}
          ></openclaw-channel-avatar>`,
          ...runState,
          circular: true,
          badge: session.unread && !running ? renderSessionUnreadBadge() : nothing,
        }),
      };
    }
    return {
      running,
      leadingIndicator: running
        ? renderSessionGlyph({ content: nothing, ...runState })
        : renderSessionIdleState(session),
    };
  }

  if (session.attention.kind !== "none") {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderSessionAttentionIcon(session.attention, true),
        ...runState,
        badge: session.unread && !running ? renderSessionUnreadBadge() : nothing,
      }),
    };
  }
  if (session.icon) {
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: renderPersistentSessionIcon(session.icon),
        ...runState,
        badge: session.unread && !running ? renderSessionUnreadBadge() : nothing,
      }),
    };
  }
  const ownerChip = ownerActor?.id?.trim()
    ? renderSessionOwnerChip(
        ownerActor,
        "row",
        attribution,
        ownerViewing,
        participants,
        participantCount,
      )
    : undefined;
  if (session.channelAvatarUrl) {
    ensureChannelAvatarElement();
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        // The owner chip stays visible until a usable avatar blob loads, so a
        // slow, unauthenticated, or 404 route never leaves an empty lead slot.
        content: html`<openclaw-channel-avatar
          .routeUrl=${session.channelAvatarUrl}
          .authTokens=${avatarAuth?.authTokens ?? []}
          .authReady=${avatarAuth?.authReady ?? false}
          .fallback=${ownerChip ?? nothing}
        ></openclaw-channel-avatar>`,
        ...runState,
        badge: session.unread && !running ? renderSessionUnreadBadge() : nothing,
        circular: true,
      }),
    };
  }
  if (ownerChip) {
    // The chip stacks a second face (or +N) behind the owner whenever anyone
    // else participates; the run state then traces that pair instead of a circle.
    const stackedParticipants = participantCount ?? participants?.length ?? 0;
    return {
      running,
      leadingIndicator: renderSessionGlyph({
        content: ownerChip,
        ...runState,
        badge: session.unread && !running ? renderSessionUnreadBadge() : nothing,
        circular: true,
        ring: stackedParticipants > 0 ? "pair" : "circle",
      }),
      // Exclude only visible avatars; a +N stack still needs individual live viewers.
      renderedIdentities: [
        ...(ownerActor?.identity ? [ownerActor.identity] : []),
        ...(stackedParticipants === 1
          ? (participants ?? []).slice(0, 1).map((participant) => participant.identity)
          : []),
      ],
    };
  }
  return {
    running,
    leadingIndicator: running
      ? renderSessionGlyph({ content: nothing, ...runState })
      : session.unread
        ? renderSessionIdleState(session)
        : nothing,
  };
}
