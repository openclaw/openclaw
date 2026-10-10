import { createMemo, Show } from "solid-js";
import type { SessionParticipant } from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { resolveAvatar } from "../../lib/identity-avatar.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  sessionOwnerInitials,
  type SessionCreatedActor,
  type SessionOwnerOption,
} from "../../lib/session-owner.ts";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";

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
  const avatar = createMemo(() => {
    const resolved = resolveAvatar({
      id: props.owner.id,
      identity: props.owner.identity,
      name: props.owner.label,
      profileAvatarUrl: props.owner.avatarUrl,
    });
    return resolved.kind === "profile" ? resolved.url : null;
  });
  return (
    <Show
      when={props.owner.identity?.type === "agent"}
      fallback={
        <openclaw-viewer-avatar
          prop:identity={props.owner.identity}
          prop:user={{
            id: props.owner.id,
            name: props.owner.label,
            avatarUrl: props.owner.avatarUrl,
            watchedSessions: [],
          }}
          prop:markAsViewer={false}
          variant="session"
          aria-hidden="true"
        />
      }
    >
      <span
        class="viewer-avatar viewer-avatar--session"
        aria-label={props.owner.label || props.owner.id}
      >
        <AgentIdentityAvatar
          agent={{
            id: props.owner.identity!.id,
            avatar: avatar(),
          }}
        />
      </span>
    </Show>
  );
}

export function SessionOwnerChipContent(props: SessionOwnerChipProps) {
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
  const avatar = createMemo(() =>
    owner()
      ? resolveAvatar({
          id: owner()!.id,
          identity: owner()!.identity,
          name: owner()!.label,
          profileAvatarUrl: owner()!.avatarUrl,
        })
      : null,
  );
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
        when={owner()!.identity?.type === "agent" || avatar()?.kind === "profile"}
        fallback={<span class="session-owner-chip__initials">{initials()}</span>}
      >
        <SessionOwnerAvatar owner={{ ...owner()!, id: owner()!.id! }} />
      </Show>
    </span>
  );
  return (
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
              {(person) => <SessionOwnerAvatar owner={{ ...person(), id: person().identity.id }} />}
            </Show>
          </span>
          {chip()}
        </span>
      </Show>
    </Show>
  );
}
