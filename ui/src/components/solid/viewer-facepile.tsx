import { createMemo, For, Show } from "solid-js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { sessionParticipantIdentityKey } from "../../lib/chat/sender-label.ts";
import { resolveAvatar } from "../../lib/identity-avatar.ts";
import {
  presenceViewerLabel as readPresenceViewerLabel,
  projectPresenceViewers,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { personActivityLink, type PersonActivityRouting } from "../person-activity-link.ts";
import { IdentityAvatarImage, identityAvatarState } from "./identity-avatar-image.tsx";
import { useIdentityAvatarView } from "./identity-avatar-view.ts";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";
import "../tooltip.ts";

function presenceViewerLabel(user: Pick<PresenceViewer, "id" | "name" | "email">) {
  i18nRevision();
  return readPresenceViewerLabel(user);
}

export const EMPTY_VIEWER_IDENTITIES: readonly SessionParticipantIdentity[] = Object.freeze([]);

type FacepileUser = Omit<PresenceViewer, "identity"> & { identity?: SessionParticipantIdentity };

export type ViewerAvatarProps = {
  user?: FacepileUser | null;
  variant?: "session" | "footer" | "profile";
  identity?: SessionParticipantIdentity;
  markAsViewer?: boolean;
};

export function ViewerAvatarContent(props: ViewerAvatarProps) {
  const view = useIdentityAvatarView(() => ({
      identity: props.identity ?? props.user?.identity,
      id: props.user?.id,
      name: props.user?.name,
      username: props.user?.email,
      profileAvatarUrl: props.user?.avatarUrl,
    }));
  return (
    <Show when={props.user}>
      <span
        ref={identityAvatarState(view)}
        class={["viewer-avatar", `viewer-avatar--${props.variant ?? "session"}`]}
        data-viewer-id={props.markAsViewer !== false ? props.user?.id : undefined}
        aria-label={
          props.variant === "profile"
            ? (props.user?.name ?? props.user?.email ?? props.user?.id)
            : presenceViewerLabel(props.user!)
        }
      >
        <Show when={Boolean(view().imageUrl)}>
          <IdentityAvatarImage view={view()} fallbackSelector=".viewer-avatar" />
        </Show>
        <span
          class={view().imageUrl ? "viewer-avatar__fallback" : undefined}
          style={{ background: `hsl(${view().fallback.colorSeed % 360} 48% 42%)` }}
        >
          <span class="viewer-avatar__initials">{view().fallback.initials}</span>
        </span>
      </span>
    </Show>
  );
}

export type ViewerFacepileProps = {
  presencePayload?: unknown;
  selfUser?: AuthenticatedUser | null;
  selfInstanceId?: string;
  sessionKey?: string;
  excludeIdentities?: readonly SessionParticipantIdentity[];
  staticParticipants?: readonly SessionParticipant[];
  staticUsers?: readonly PresenceViewer[];
  maxVisible?: number;
  totalCount?: number;
  personActivity?: PersonActivityRouting;
};

export function ViewerFacepileContent(props: ViewerFacepileProps) {
  const users = createMemo(() =>
    props.staticParticipants
      ? props.staticParticipants.map(({ identity, label, avatarUrl }) => ({
          identity,
          id: identity.id,
          name: label,
          avatarUrl,
          watchedSessions: [],
        }))
      : (props.staticUsers ??
        projectPresenceViewers(
          props.presencePayload,
          props.selfUser,
          props.selfInstanceId,
          props.sessionKey,
          props.excludeIdentities ?? EMPTY_VIEWER_IDENTITIES,
        )),
  );
  const visible = createMemo(() => users().slice(0, props.maxVisible ?? 3));
  const overflowCount = () => Math.max(users().length, props.totalCount ?? 0) - visible().length;
  const overflowLabel = () => {
    const overflow = users().slice(props.maxVisible ?? 3);
    return overflow.length === overflowCount()
      ? overflow.map(presenceViewerLabel).join("\n")
      : t("sessionHovercard.moreParticipantsLabel", { count: String(overflowCount()) });
  };
  return (
    <Show when={users().length > 0}>
      <span
        class="viewer-facepile viewer-facepile--session"
        data-viewer-count={Math.max(users().length, props.totalCount ?? 0)}
        aria-label={users().map(presenceViewerLabel).join(", ")}
      >
        <For
          each={visible()}
          keyed={(user) =>
            user.identity ? sessionParticipantIdentityKey(user.identity) : `raw:${user.id}`
          }
        >
          {(user) => (
            <openclaw-tooltip prop:content={presenceViewerLabel(user())}>
              <span class="viewer-facepile__tooltip-anchor">
                <FacepilePerson
                  user={user()}
                  markAsViewer={!props.staticParticipants}
                  routing={props.personActivity}
                />
              </span>
            </openclaw-tooltip>
          )}
        </For>
        <Show when={overflowCount() > 0}>
          <openclaw-tooltip prop:content={overflowLabel()}>
            <span class="viewer-avatar viewer-avatar--overflow" aria-label={overflowLabel()}>
              +{overflowCount()}
            </span>
          </openclaw-tooltip>
        </Show>
      </span>
    </Show>
  );
}

function FacepilePerson(props: {
  user: FacepileUser;
  markAsViewer: boolean;
  routing?: PersonActivityRouting;
}) {
  const link = createMemo(() =>
    props.user.identity?.type === "profile"
      ? personActivityLink(props.user.identity.id, props.routing, presenceViewerLabel(props.user))
      : null,
  );
  const avatar = () =>
    props.user.identity?.type === "agent" ? (
      <AgentViewerAvatar
        user={props.user}
        identity={props.user.identity}
        markAsViewer={props.markAsViewer}
      />
    ) : (
      <ViewerAvatar
        user={props.user}
        identity={props.user.identity}
        markAsViewer={props.markAsViewer}
        variant="session"
      />
    );
  return (
    <Show when={link()} fallback={avatar()}>
      {(target) => (
        <a
          class="person-activity-avatar-link"
          href={target().href}
          onClick={(event) => target().open(event)}
        >
          {avatar()}
        </a>
      )}
    </Show>
  );
}

export function AgentViewerAvatar(props: {
  user: Pick<PresenceViewer, "id" | "name" | "email" | "avatarUrl">;
  identity: Extract<SessionParticipantIdentity, { type: "agent" }>;
  markAsViewer?: boolean;
  label?: string;
}) {
  const avatar = createMemo(() => {
    const resolved = resolveAvatar({
      identity: props.identity,
      id: props.user.id,
      name: props.user.name,
      profileAvatarUrl: props.user.avatarUrl,
    });
    return resolved.kind === "profile" ? resolved.url : null;
  });
  return (
    <span
      class="viewer-avatar viewer-avatar--session"
      aria-label={props.label ?? presenceViewerLabel(props.user)}
      data-viewer-id={props.markAsViewer ? props.user.id : undefined}
    >
      <AgentIdentityAvatar agent={{ id: props.identity.id, avatar: avatar() }} />
    </span>
  );
}

export type ViewerAvatarElement = SolidBridgeElement<ViewerAvatarProps>;
export type ViewerFacepileElement = SolidBridgeElement<ViewerFacepileProps>;

export const ViewerAvatar = defineSolidBridge<ViewerAvatarProps>(
  "openclaw-viewer-avatar",
  (props, host) => {
    host.style.display = "contents";
    return <ViewerAvatarContent {...props} />;
  },
  {
    properties: {
      user: { default: null, attribute: false },
      variant: { default: "session" },
      identity: { default: undefined, attribute: false },
      markAsViewer: { default: true, attribute: false },
    },
  },
);

defineSolidBridge<ViewerFacepileProps>(
  "openclaw-viewer-facepile",
  (props, host) => {
    host.style.display = "contents";
    return <ViewerFacepileContent {...props} />;
  },
  {
    properties: {
      presencePayload: { default: undefined, attribute: false },
      selfUser: { default: undefined, attribute: false },
      selfInstanceId: { default: undefined, attribute: false },
      sessionKey: { default: undefined, attribute: false },
      excludeIdentities: { default: EMPTY_VIEWER_IDENTITIES, attribute: false },
      staticParticipants: { default: undefined, attribute: false },
      staticUsers: { default: undefined, attribute: false },
      maxVisible: { default: 3, attribute: "max-visible", type: Number },
      totalCount: { default: undefined, attribute: false },
      personActivity: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-viewer-avatar": ViewerAvatarElement;
    "openclaw-viewer-facepile": ViewerFacepileElement;
  }
}
