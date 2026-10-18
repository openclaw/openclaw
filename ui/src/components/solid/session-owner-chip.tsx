import { createMemo, Show } from "solid-js";
import type { SessionParticipant } from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import { resolveAvatar } from "../../lib/identity-avatar.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  sessionOwnerInitials,
  type SessionCreatedActor,
  type SessionOwnerOption,
} from "../../lib/session-owner.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { AgentViewerAvatar, ViewerAvatar } from "./viewer-facepile.tsx";

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
  const identity = () => {
    const value = props.owner.identity;
    return value?.type === "agent" ? value : undefined;
  };
  return (
    <Show
      when={identity()}
      fallback={
        <ViewerAvatar
          identity={props.owner.identity}
          user={{
            id: props.owner.id,
            name: props.owner.label,
            avatarUrl: props.owner.avatarUrl,
            watchedSessions: [],
          }}
          markAsViewer={false}
          variant="session"
          aria-hidden="true"
        />
      }
    >
      {(agent) => (
        <AgentViewerAvatar
          user={{ id: props.owner.id, name: props.owner.label, avatarUrl: props.owner.avatarUrl }}
          identity={agent()}
          label={props.owner.label || props.owner.id}
        />
      )}
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
        when={
          owner()!.identity?.type === "agent" ||
          owner()!.identity?.type === "profile" ||
          avatar()?.kind === "profile"
        }
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

export type SessionOwnerChipElement = SolidBridgeElement<SessionOwnerChipProps>;
export const SessionOwnerChip = defineSolidBridge<SessionOwnerChipProps>(
  "openclaw-session-owner-chip",
  (props) => <SessionOwnerChipContent {...props} />,
  {
    properties: {
      owner: { default: null, attribute: false },
      size: { default: "row" },
      attribution: { default: "created" },
      viewingNow: { default: undefined, attribute: false },
      participants: { default: [], attribute: false },
      participantCount: { default: 0, type: Number },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-owner-chip": SessionOwnerChipElement;
  }
}
