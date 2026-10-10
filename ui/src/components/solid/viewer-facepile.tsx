import { dynamic, type JSX } from "@solidjs/web";
import { createComponent, createMemo, For, Show } from "solid-js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { ApplicationContext } from "../../app/context-types.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { sessionParticipantIdentityKey } from "../../lib/chat/sender-label.ts";
import { resolveAvatar } from "../../lib/identity-avatar.ts";
import {
  presenceViewerLabel,
  projectPresenceViewers,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveIdentityAvatarView } from "../identity-avatar-view.ts";
import { personActivityLink, type PersonActivityRouting } from "../person-activity-link.ts";
import { useIdentityApplication } from "./identity-application.ts";
import { IdentityAvatarImage, identityAvatarState } from "./identity-avatar-image.tsx";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";
import "../tooltip.ts";

const TooltipTag = dynamic(() => "openclaw-tooltip");
function Tooltip(props: { content: string; children: JSX.Element }) {
  return createComponent(TooltipTag, {
    get "prop:content"() {
      return props.content;
    },
    get children() {
      return props.children;
    },
  });
}

export const EMPTY_VIEWER_IDENTITIES: readonly SessionParticipantIdentity[] = Object.freeze([]);

type FacepileUser = Omit<PresenceViewer, "identity"> & { identity?: SessionParticipantIdentity };

export type ViewerAvatarProps = {
  user?: FacepileUser | null;
  variant?: "session" | "footer" | "profile";
  identity?: SessionParticipantIdentity;
  markAsViewer?: boolean;
  application?: ApplicationContext;
};

export function ViewerAvatarContent(props: ViewerAvatarProps) {
  const application = useIdentityApplication();
  const gateway = createMemo(() => {
    const context = props.application ?? application;
    return context ? projectGateway(context.gateway) : undefined;
  });
  const selfAvatarUrl = () => {
    const identity = props.identity ?? props.user?.identity;
    const self = gateway()?.read().snapshot.selfUser;
    return identity?.type === "profile" &&
      self?.identity?.type === "profile" &&
      identity.id === self.identity.id
      ? self.avatarUrl
      : undefined;
  };
  const view = createMemo(() =>
    resolveIdentityAvatarView({
      identity: props.identity ?? props.user?.identity,
      id: props.user?.id,
      name: props.user?.name,
      username: props.user?.email,
      profileAvatarUrl: props.user?.avatarUrl?.trim() || selfAvatarUrl(),
    }),
  );
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
        <Show when={view().imageUrl}>
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
            <Tooltip content={presenceViewerLabel(user())}>
              <span class="viewer-facepile__tooltip-anchor">
                <FacepilePerson
                  user={user()}
                  markAsViewer={!props.staticParticipants}
                  routing={props.personActivity}
                />
              </span>
            </Tooltip>
          )}
        </For>
        <Show when={overflowCount() > 0}>
          <Tooltip content={overflowLabel()}>
            <span class="viewer-avatar viewer-avatar--overflow" aria-label={overflowLabel()}>
              +{overflowCount()}
            </span>
          </Tooltip>
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
      <openclaw-viewer-avatar
        prop:user={props.user}
        prop:identity={props.user.identity}
        prop:markAsViewer={props.markAsViewer}
        variant="session"
      />
    );
  return (
    <Show when={link()} fallback={avatar()}>
      {(target) => (
        <a class="person-activity-avatar-link" href={target().href} onClick={target().open}>
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
      aria-label={presenceViewerLabel(props.user)}
      data-viewer-id={props.markAsViewer ? props.user.id : undefined}
    >
      <AgentIdentityAvatar agent={{ id: props.identity.id, avatar: avatar() }} />
    </span>
  );
}
