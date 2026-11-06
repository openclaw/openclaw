import { Show } from "solid-js";
import type { SessionParticipant } from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { resolveAvatar } from "../../lib/identity-avatar.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  sessionOwnerInitials,
  type SessionCreatedActor,
  type SessionOwnerOption,
} from "../../lib/session-owner.ts";
import { ParticipantAvatar } from "./viewer-facepile.tsx";

export type SessionOwnerChipProps = {
  owner?: SessionCreatedActor | null;
  size?: "row" | "header";
  attribution?: "created" | "owned" | "archived";
  viewingNow?: boolean;
  participants?: readonly SessionParticipant[];
  participantCount?: number;
};

function ownerHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function SessionOwnerAvatar(props: {
  owner: Pick<SessionOwnerOption, "id" | "label" | "avatarUrl" | "identity">;
}) {
  // Reconcile owner facts without replacing the bridge's user prop.
  const user = {
    get id() {
      return props.owner.id;
    },
    get name() {
      return props.owner.label;
    },
    get avatarUrl() {
      return props.owner.avatarUrl;
    },
    get identity() {
      return props.owner.identity;
    },
    watchedSessions: [],
  };
  return (
    <ParticipantAvatar
      user={user}
      markAsViewer={false}
      label={props.owner.label || props.owner.id}
      aria-hidden="true"
    />
  );
}

export function SessionOwnerChip(props: SessionOwnerChipProps) {
  const owner = () => props.owner;
  const initials = () => (owner() ? sessionOwnerInitials(owner()!) : "");
  const label = () => {
    const attribution = t(
      props.attribution === "archived"
        ? "sessionsView.archivedBy"
        : props.attribution === "owned"
          ? "sessionsView.ownedBy"
          : "sessionsView.createdBy",
      { name: owner()?.label || owner()?.id || "" },
    );
    return props.viewingNow ? `${attribution} · ${t("sessionsView.viewingNow")}` : attribution;
  };
  const stacked = () => (props.size ?? "row") === "row" && (props.participantCount ?? 0) > 0;
  const participant = () => props.participants?.[0];
  const combinedLabel = () => {
    const title = participant()?.label || participant()?.identity.id;
    return `${label()} · ${props.participantCount === 1 && title ? t("sessionsView.withParticipant", { name: title }) : t("sessionsView.withMoreParticipants", { count: String(props.participantCount) })}`;
  };
  const chip = () => (
    <span
      class={[
        "session-owner-chip",
        `session-owner-chip--${props.size ?? "row"}`,
        {
          "session-owner-chip--away": props.viewingNow === false,
          "session-owner-stack__front": stacked(),
        },
      ]}
      style={{ "--owner-hue": ownerHue(owner()!.id!) }}
      role="img"
      aria-label={label()}
      title={label()}
    >
      <Show
        when={
          owner()!.identity?.type === "agent" ||
          owner()!.identity?.type === "profile" ||
          resolveAvatar({
            id: owner()!.id,
            identity: owner()!.identity,
            name: owner()!.label,
            profileAvatarUrl: owner()!.avatarUrl,
          }).kind === "profile"
        }
        fallback={<span class="session-owner-chip__initials">{initials()}</span>}
      >
        <SessionOwnerAvatar owner={{ ...owner()!, id: owner()!.id! }} />
      </Show>
    </span>
  );
  return (
    <openclaw-session-owner-chip size={props.size} attribution={props.attribution}>
      <Show when={owner()?.id && initials()}>
        <Show when={stacked()} fallback={chip()}>
          <span
            class={[
              "session-owner-stack",
              { "session-owner-stack--overflow": (props.participantCount ?? 0) > 1 },
            ]}
            role="group"
            aria-label={combinedLabel()}
          >
            <span class="session-owner-stack__back" aria-hidden="true">
              <Show
                when={props.participantCount === 1 && participant()}
                fallback={
                  <span class="session-owner-stack__overflow">
                    <span class="session-owner-stack__count">+{props.participantCount}</span>
                  </span>
                }
              >
                {(person) => (
                  <SessionOwnerAvatar owner={{ ...person(), id: person().identity.id }} />
                )}
              </Show>
            </span>
            {chip()}
          </span>
        </Show>
      </Show>
    </openclaw-session-owner-chip>
  );
}
