import { createMemo, For, onSettled, Show } from "solid-js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { sessionParticipantIdentityKey } from "../../lib/chat/sender-label.ts";
import { resolveAvatar } from "../../lib/identity-avatar.ts";
import {
  presenceViewerLabel as readPresenceViewerLabel,
  projectPresenceViewers,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import {
  sharedAgentIdentityProjection,
  sharedAgentsProjection,
} from "../../lib/reactive/shared-application-projections.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { personActivityLink, type PersonActivityRouting } from "../person-activity-link.ts";
import { IdentityAvatarImage, createIdentityAvatarPresentation } from "./identity-avatar-image.tsx";
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

export const ViewerAvatar = defineSolidBridge<ViewerAvatarProps>(
  "openclaw-viewer-avatar",
  (props, host) => {
    host.style.display = "contents";
    const view = useIdentityAvatarView(() => ({
      identity: props.identity ?? props.user?.identity,
      id: props.user?.id,
      name: props.user?.name,
      username: props.user?.email,
      profileAvatarUrl: props.user?.avatarUrl,
    }));
    const presentation = createIdentityAvatarPresentation(view);
    const fallbackColor = () => `hsl(${view().fallback.colorSeed % 360} 48% 42%)`;
    return (
      <Show when={props.user}>
        <span
          data-avatar-state={presentation.state()}
          style={{ "--viewer-avatar-color": fallbackColor() }}
          class={[
            "viewer-avatar",
            `viewer-avatar--${props.variant ?? "session"}`,
            presentation.classes(),
          ]}
          data-viewer-id={props.markAsViewer !== false ? props.user?.id : undefined}
          aria-label={
            props.variant === "profile"
              ? (props.user?.name ?? props.user?.email ?? props.user?.id)
              : presenceViewerLabel(props.user!)
          }
        >
          <Show when={Boolean(view().imageUrl)}>
            <IdentityAvatarImage view={view()} onStateChange={presentation.onStateChange} />
          </Show>
          <span
            class={view().imageUrl ? "viewer-avatar__fallback" : undefined}
            style={{ background: fallbackColor() }}
          >
            <span class="viewer-avatar__initials">{view().fallback.initials}</span>
          </span>
        </span>
      </Show>
    );
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

export type ViewerFacepileProps = {
  presencePayload?: unknown;
  selfUser?: AuthenticatedUser | null;
  selfInstanceId?: string;
  sessionKey?: string;
  excludeIdentities?: readonly SessionParticipantIdentity[];
  staticParticipants?: readonly SessionParticipant[];
  staticUsers?: readonly PresenceViewer[];
  maxVisible?: number;
  /** The "+N" face takes the last of maxVisible slots instead of adding one. */
  overflowInSlots?: boolean;
  totalCount?: number;
  personActivity?: PersonActivityRouting;
  registerLink?: (element: HTMLAnchorElement) => (() => void) | undefined;
};

const mountedFacepiles = new Map<HTMLElement, ViewerFacepileProps>();

export const ViewerFacepile = defineSolidBridge<ViewerFacepileProps>(
  "openclaw-viewer-facepile",
  (props, host) => {
    host.style.display = "contents";
    onSettled(() => {
      mountedFacepiles.set(host, host);
      return () => mountedFacepiles.delete(host);
    });
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
    const total = () => Math.max(users().length, props.totalCount ?? 0);
    const visible = createMemo(() => {
      const slots = props.maxVisible ?? 3;
      return users().slice(0, props.overflowInSlots && total() > slots ? slots - 1 : slots);
    });
    const overflowCount = () => total() - visible().length;
    const overflowLabel = () => {
      const overflow = users().slice(visible().length);
      return overflow.length === overflowCount()
        ? overflow.map(presenceViewerLabel).join("\n")
        : t("sessionHovercard.moreParticipantsLabel", { count: String(overflowCount()) });
    };
    return (
      <Show when={users().length > 0}>
        <span
          class="viewer-facepile viewer-facepile--session"
          data-viewer-count={total()}
          aria-label={users().map(presenceViewerLabel).join(", ")}
        >
          <For
            each={visible()}
            keyed={(user) =>
              user.identity ? sessionParticipantIdentityKey(user.identity) : `raw:${user.id}`
            }
          >
            {(user) => (
              <FacepilePerson
                user={user()}
                markAsViewer={!props.staticParticipants}
                routing={props.personActivity}
                registerLink={props.registerLink}
              />
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
      overflowInSlots: { default: false, attribute: false },
      totalCount: { default: undefined, attribute: false },
      personActivity: { default: undefined, attribute: false },
      registerLink: { default: undefined, attribute: false },
    },
  },
);

function FacepilePerson(props: {
  user: FacepileUser;
  markAsViewer: boolean;
  routing?: PersonActivityRouting;
  registerLink?: ViewerFacepileProps["registerLink"];
}) {
  const link = createMemo(() =>
    props.user.identity?.type === "profile"
      ? personActivityLink(props.user.identity.id, props.routing, presenceViewerLabel(props.user))
      : null,
  );
  const avatar = <ParticipantAvatar user={props.user} markAsViewer={props.markAsViewer} />;
  let profileLink: HTMLAnchorElement | undefined;
  return (
    <openclaw-tooltip
      prop:content={presenceViewerLabel(props.user)}
      prop:descriptionTarget={link() ? () => profileLink ?? null : undefined}
    >
      <span class="viewer-facepile__tooltip-anchor">
        <Show when={link()} fallback={avatar}>
          {(target) => {
            let anchor!: HTMLAnchorElement;
            onSettled(() => props.registerLink?.(anchor));
            return (
              <a
                ref={(element) => {
                  anchor = element;
                  profileLink = element;
                }}
                class="person-activity-avatar-link"
                href={target().href}
                onClick={(event) => target().open(event)}
              >
                {avatar}
              </a>
            );
          }}
        </Show>
      </span>
    </openclaw-tooltip>
  );
}

export function ParticipantAvatar(props: {
  user: FacepileUser;
  markAsViewer?: boolean;
  label?: string;
  "aria-hidden"?: "true";
}) {
  const agent = () => {
    const identity = props.user.identity;
    return identity?.type === "agent" ? identity : undefined;
  };
  return (
    <Show
      when={agent()}
      fallback={
        <ViewerAvatar
          user={props.user}
          markAsViewer={props.markAsViewer}
          variant="session"
          aria-hidden={props["aria-hidden"]}
        />
      }
    >
      {(identity) => {
        const app = useOptionalApplication();
        const agents = app ? sharedAgentsProjection(app.agents) : undefined;
        const agentIdentity = app ? sharedAgentIdentityProjection(app.agentIdentity) : undefined;
        const avatar = createMemo(() => {
          const rosterAgent = agents
            ?.read()
            .agentsList?.agents.find((entry) => entry.id === identity().id);
          const hydrated = agentIdentity?.read().get(identity().id);
          const resolved = resolveAvatar({
            identity: identity(),
            id: props.user.id,
            name: props.user.name,
            profileAvatarUrl: props.user.avatarUrl,
          });
          return {
            id: identity().id,
            avatar: hydrated
              ? resolveAgentAvatarUrl(rosterAgent ?? {}, hydrated)
              : (resolveAgentAvatarUrl(rosterAgent ?? {}) ??
                (resolved.kind === "profile" ? resolved.url : null)),
            textAvatar: resolveAgentTextAvatar(rosterAgent ?? {}, hydrated),
          };
        });
        return (
          <span
            class="viewer-avatar viewer-avatar--session"
            aria-label={props.label ?? presenceViewerLabel(props.user)}
            data-viewer-id={props.markAsViewer ? props.user.id : undefined}
          >
            <AgentIdentityAvatar agent={avatar()} />
          </span>
        );
      }}
    </Show>
  );
}

type ViewerAvatarElement = SolidBridgeElement<ViewerAvatarProps>;
type ViewerFacepileElement = SolidBridgeElement<ViewerFacepileProps>;

export function mountedViewerSessionKeys(root: HTMLElement): ReadonlySet<string> {
  return new Set(
    [...mountedFacepiles].flatMap(([element, props]) =>
      root.contains(element) ? [props.sessionKey ?? ""] : [],
    ),
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-viewer-avatar": ViewerAvatarElement;
    "openclaw-viewer-facepile": ViewerFacepileElement;
  }
}
