import { html, nothing } from "lit";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { resolveAvatar } from "../lib/identity-avatar.ts";
import type { SessionCreatedActor, SessionOwnerOption } from "../lib/session-owner.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";
import "./viewer-facepile.ts";
import "./solid/session-owner-chip.tsx";

export { sessionOwnerInitials, sessionSelfOwner } from "../lib/session-owner.ts";
export type { SessionCreatedActor, SessionOwnerOption } from "../lib/session-owner.ts";

export function renderSessionOwnerChip(
  owner: SessionCreatedActor | null | undefined,
  size: "row" | "header",
  attribution: "created" | "owned" | "archived" = "created",
  viewingNow?: boolean,
  participants?: readonly SessionParticipant[],
  participantCount?: number,
) {
  return owner?.id
    ? html`<openclaw-session-owner-chip
        .owner=${owner}
        size=${size}
        attribution=${attribution}
        .viewingNow=${viewingNow}
        .participants=${participants ?? []}
        .participantCount=${participantCount ?? participants?.length ?? 0}
      ></openclaw-session-owner-chip>`
    : nothing;
}

export function renderSessionOwnerAvatar(
  owner: Pick<SessionOwnerOption, "id" | "label" | "avatarUrl" | "identity">,
) {
  if (owner.identity?.type === "agent") {
    const avatar = resolveAvatar({
      id: owner.id,
      identity: owner.identity,
      name: owner.label,
      profileAvatarUrl: owner.avatarUrl,
    });
    return html`<span
      class="viewer-avatar viewer-avatar--session"
      aria-label=${owner.label || owner.id}
    >
      ${renderAgentIdentityAvatar({ id: owner.identity.id, avatar: avatar.kind === "profile" ? avatar.url : null })}
    </span>`;
  }
  return html`<openclaw-viewer-avatar
    .identity=${owner.identity}
    .user=${{
      id: owner.id,
      name: owner.label,
      avatarUrl: owner.avatarUrl,
      watchedSessions: [],
    }}
    .markAsViewer=${false}
    variant="session"
    aria-hidden="true"
  ></openclaw-viewer-avatar>`;
}
