import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, onCleanup } from "solid-js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import {
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../../packages/gateway-protocol/src/session-agent-status.js";
import { resolveToolDisplayIcon } from "../../lib/chat/tool-display-icon.ts";
import { resolveAvatar } from "../../lib/identity-avatar.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  summarizeSidebarSessionAttention,
  type SidebarRecentSession,
  type SidebarSessionAttention,
} from "../app-sidebar-session-types.ts";
import {
  sessionAttentionTooltipParts,
  sessionAttentionIconName,
  resolveSessionIdleBadge,
} from "../session-attention-presentation.ts";
import type { SessionGlyphRing } from "../session-glyph.ts";
import type { SessionCreatedActor, SessionOwnerOption } from "../session-owner-chip.ts";
import {
  resolveSessionRowBadges,
  type SessionRowBadgesParams,
} from "../session-row-badge-presentation.ts";
import type { resolveSidebarSessionSubtitle } from "../session-row-subtitle.ts";
import { SessionRunVisibilityController } from "../session-run-visibility-controller.ts";
import { ChannelAvatar } from "./channel-avatar.tsx";
import { Icon } from "./icon.tsx";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";
import { SessionOwnerChip } from "./session-owner-chip.tsx";
import { ViewerAvatar } from "./viewer-facepile.tsx";
import "../tooltip.ts";

export type SessionRunVisibility = (element: Element) => void;
export function sessionRunVisibility(): SessionRunVisibility {
  const controller = new SessionRunVisibilityController();
  onCleanup(() => controller.disconnect());
  return (element) => controller.connect(element);
}

function SessionAttentionIcon(props: { attention: SidebarSessionAttention }) {
  const parts = createMemo(() => sessionAttentionTooltipParts(props.attention, t));
  const label = () =>
    [parts().status, parts().preview, parts().more].filter(Boolean).join("\n") || undefined;
  const icon = () => sessionAttentionIconName(props.attention);
  return (
    <Show when={props.attention.kind !== "none"}>
      <openclaw-tooltip prop:content={parts().preview ? "" : parts().status} open-on-click>
        <span
          class={`sidebar-session-attention__icon sidebar-session-attention__icon--${props.attention.kind}`}
          data-session-attention={props.attention.kind}
          role={label() ? "img" : undefined}
          aria-label={label()}
          aria-hidden={label() ? undefined : "true"}
          tabindex={label() ? 0 : undefined}
          onFocusIn={(event) => {
            if (label()) {
              event.stopPropagation();
            }
          }}
          onClick={(event) => {
            if (label()) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          <Icon name={icon()} />
        </span>
        <Show when={parts().preview}>
          <span slot="content" class="sidebar-session-attention-tooltip">
            <strong>{parts().status}</strong>
            <span class="sidebar-session-attention-tooltip__preview">{parts().preview}</span>
            <Show when={parts().more}>
              <span>{parts().more}</span>
            </Show>
          </span>
        </Show>
      </openclaw-tooltip>
    </Show>
  );
}
export function renderSessionAttentionIcon(attention: SidebarSessionAttention): JSX.Element {
  return attention.kind === "none" ? undefined : <SessionAttentionIcon attention={attention} />;
}

const PAIR_TRACE_PATH = "M0,-9.798A11,11 0 1 1 0,9.798A11,11 0 1 1 0,-9.798Z";
type SessionGlyphOptions = {
  content: JSX.Element;
  running: boolean;
  queued?: boolean;
  runningLabel?: string;
  circular?: boolean;
  badge?: JSX.Element;
  ring?: SessionGlyphRing;
  runVisibility?: SessionRunVisibility;
};
export function SessionGlyph(props: SessionGlyphOptions) {
  const label = () =>
    props.runningLabel ?? t(props.queued ? "sessionsView.statusQueued" : "sessionsView.activeRun");
  const glyph = () => (
    <span
      class={[
        "session-glyph",
        {
          "session-glyph--circular": props.circular,
          "session-glyph--running": props.running,
          "session-glyph--bare": props.content == null || props.content === false,
        },
      ]}
    >
      <span class="session-glyph__content">{props.content}</span>
      <Show when={props.running}>
        {props.ring === "pair" ? (
          <svg
            class={["session-glyph__trace", { "session-glyph__trace--queued": props.queued }]}
            viewBox="-16 -11 32 22"
            role="img"
            aria-label={label()}
          >
            <path class="session-glyph__trace-track" d={PAIR_TRACE_PATH} />
            <path
              ref={props.runVisibility}
              class="session-glyph__trace-run"
              d={PAIR_TRACE_PATH}
              pathLength="100"
            />
          </svg>
        ) : (
          <span
            ref={props.runVisibility}
            class={["session-glyph__ring", { "session-glyph__ring--queued": props.queued }]}
            role="img"
            aria-label={label()}
          />
        )}
      </Show>
      {props.badge}
    </span>
  );
  return (
    <Show when={props.running && props.runningLabel} fallback={glyph()}>
      <openclaw-tooltip prop:content={props.runningLabel} prop:describe={false}>
        {glyph()}
      </openclaw-tooltip>
    </Show>
  );
}

export function renderSessionUnreadBadge(): JSX.Element {
  return (
    <span
      class="session-glyph__badge session-glyph__badge--unread"
      role="img"
      aria-label={t("sessionsView.unread")}
    />
  );
}

export function SessionRowBadges(props: SessionRowBadgesParams) {
  const badges = createMemo(() => resolveSessionRowBadges(props, t));
  return (
    <Show when={badges().length}>
      <span class="session-row-badges">
        <For each={badges()} keyed={(badge) => badge.modifier}>
          {(badge) => (
            <openclaw-tooltip prop:content={badge().label}>
              <span
                class={`session-row-badge session-row-badge--${badge().modifier}`}
                data-pull-request-state={badge().pullRequestState}
                data-placement-state={badge().placementState}
                data-disk-space-status={badge().diskSpaceStatus}
                data-workspace-conflicts={
                  badge().workspaceConflictCount
                    ? String(badge().workspaceConflictCount)
                    : undefined
                }
                role="img"
                aria-label={badge().label}
              >
                <Icon name={badge().icon} />
                <Show when={badge().count}>
                  <span aria-hidden="true">{badge().count}</span>
                </Show>
              </span>
            </openclaw-tooltip>
          )}
        </For>
      </span>
    </Show>
  );
}

type SidebarSessionSubtitle = ReturnType<typeof resolveSidebarSessionSubtitle>;
export function SidebarSessionSubtitle(props: SidebarSessionSubtitle) {
  const label = () =>
    props.toolName ? `${t("chat.toolCards.tool")}: ${props.toolName}` : undefined;
  return (
    <Show when={props.subtitle}>
      <Show when={props.toolName}>
        <openclaw-tooltip prop:content={label()} prop:describe={false}>
          <span class="sidebar-session-tool" role="img" aria-label={label()}>
            <Icon name={resolveToolDisplayIcon(props.toolName ?? "")} />
          </span>
        </openclaw-tooltip>
      </Show>
      <Show
        when={props.narration}
        fallback={<span class="sidebar-recent-session__subtitle">{props.subtitle}</span>}
      >
        <span class="sidebar-recent-session__subtitle sidebar-recent-session__subtitle--narration">
          {props.subtitle}
        </span>
      </Show>
    </Show>
  );
}

export function renderSessionOwnerChip(
  owner: SessionCreatedActor | null | undefined,
  size: "row" | "header",
  attribution: "created" | "owned" | "archived" = "created",
  viewingNow?: boolean,
  participants?: readonly SessionParticipant[],
  participantCount?: number,
): JSX.Element {
  return owner?.id ? (
    <SessionOwnerChip
      owner={owner}
      size={size}
      attribution={attribution}
      viewingNow={viewingNow}
      participants={participants ?? []}
      participantCount={participantCount ?? participants?.length ?? 0}
    />
  ) : undefined;
}
export function renderSessionOwnerAvatar(
  owner: Pick<SessionOwnerOption, "id" | "label" | "avatarUrl" | "identity">,
): JSX.Element {
  if (owner.identity?.type === "agent") {
    const avatar = resolveAvatar({
      id: owner.id,
      identity: owner.identity,
      name: owner.label,
      profileAvatarUrl: owner.avatarUrl,
    });
    return (
      <span class="viewer-avatar viewer-avatar--session" aria-label={owner.label || owner.id}>
        <AgentIdentityAvatar
          agent={{ id: owner.identity.id, avatar: avatar.kind === "profile" ? avatar.url : null }}
        />
      </span>
    );
  }
  return (
    <ViewerAvatar
      identity={owner.identity}
      user={{
        id: owner.id,
        name: owner.label,
        avatarUrl: owner.avatarUrl,
        watchedSessions: [],
      }}
      markAsViewer={false}
      variant="session"
      aria-hidden="true"
    />
  );
}

function SessionIdleState(props: { session: SidebarRecentSession }) {
  const state = () => resolveSessionIdleBadge(props.session.status, t);
  return (
    <Show
      when={props.session.isChild}
      fallback={
        props.session.unread ? (
          <span class="session-unread-dot" role="img" aria-label={t("sessionsView.unread")} />
        ) : undefined
      }
    >
      <Show when={state()}>
        {(current) => (
          <span
            class={`sidebar-child-session__status sidebar-child-session__status--${props.session.status}`}
            role="img"
            aria-label={current().label}
            title={current().label}
          >
            <Icon name={current().icon} />
          </span>
        )}
      </Show>
    </Show>
  );
}
export function renderSessionIdleState(session: SidebarRecentSession): JSX.Element {
  if (!session.isChild && !session.unread) {
    return undefined;
  }
  if (session.isChild && !resolveSessionIdleBadge(session.status, t)) {
    return undefined;
  }
  return <SessionIdleState session={session} />;
}

export function renderTeamSessionSlots(
  rows: readonly SidebarRecentSession[],
  includeChildren: boolean,
  childCount: number,
  groupConflicts = 0,
  runVisibility?: SessionRunVisibility,
): JSX.Element {
  const attention = summarizeSidebarSessionAttention(
    rows.flatMap((row) =>
      includeChildren
        ? [row.attention]
        : [
            row.ownAttention ?? row.attention,
            ...(row.subagentSummary ? [row.subagentSummary.attention] : []),
          ],
    ),
  );
  let active = 0;
  let queued = 0;
  let unread = 0;
  let failed = false;
  for (const row of rows) {
    const children = includeChildren ? row : row.subagentSummary;
    active += Number(row.hasActiveRun) + (children?.runningChildCount ?? 0);
    queued +=
      Number(row.hasActiveRun && row.status === "queued") + (children?.queuedChildCount ?? 0);
    unread += Number(row.unread) + (children?.unreadChildCount ?? 0);
    failed ||=
      row.status === "failed" || row.status === "timeout" || (children?.failedChildCount ?? 0) > 0;
  }
  const state =
    attention.kind !== "none" ? (
      renderSessionAttentionIcon(attention)
    ) : failed ? (
      <span
        class="sidebar-child-session__status--failed"
        role="img"
        aria-label={t("sessionsView.statusFailed")}
      >
        <Icon name="alertTriangle" />
      </span>
    ) : groupConflicts ? (
      <span
        role="img"
        aria-label={t("sessionsView.cloudWorkerDescendantConflicts", {
          count: String(groupConflicts),
        })}
      >
        <Icon name="globe" />
      </span>
    ) : active ? (
      <SessionGlyph
        content={undefined}
        running={true}
        queued={active === queued}
        runVisibility={runVisibility}
      />
    ) : rows.length === 1 && rows[0]?.isChild ? (
      renderSessionIdleState(rows[0])
    ) : undefined;
  if ((!includeChildren || childCount === 0) && unread === 0 && state === undefined) {
    return undefined;
  }
  return (
    <span class="sidebar-session-team-state">
      <Show when={(includeChildren && childCount > 0) || unread > 0}>
        <span class="sidebar-session-team-state__counts">
          <Show when={includeChildren && childCount > 0}>
            <span
              class="sidebar-child-session-toggle__count"
              role="img"
              aria-label={`${t("sessionsView.childSessions")}: ${childCount}`}
            >
              {childCount}
            </span>
          </Show>
          <Show when={unread > 0}>
            <span
              class={unread === 1 ? "session-unread-dot" : "sidebar-agent-roster__unread"}
              role="img"
              aria-label={t("sessionsView.unread")}
              title={t("sessionsView.unread")}
            >
              {unread > 1 ? unread : undefined}
            </span>
          </Show>
        </span>
      </Show>
      <Show when={state}>
        <span class="sidebar-session-team-state__status">{state}</span>
      </Show>
    </span>
  );
}

export function resolveSessionIconGraphic(icon: string): JSX.Element {
  if (icon.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX)) {
    return <img src={icon} alt="" aria-hidden="true" />;
  }
  const glyph = SESSION_ICON_GLYPH_IDS.find((id) => id === icon);
  return glyph ? <Icon name={glyph} /> : undefined;
}

const renderedOwnerIdentities = new WeakMap<
  SidebarRecentSession,
  readonly SessionParticipantIdentity[]
>();
const EMPTY_IDENTITIES: readonly SessionParticipantIdentity[] = Object.freeze([]);
export function renderSessionLeadingState(
  session: SidebarRecentSession,
  ownerActor: SessionCreatedActor | null | undefined,
  attribution: "created" | "owned" | "archived",
  ownerViewing?: boolean,
  avatarAuth?: { authTokens: readonly string[]; authReady: boolean },
  trailingState = false,
  icon?: JSX.Element,
  runVisibility?: SessionRunVisibility,
): {
  running: boolean;
  leadingIndicator: JSX.Element;
  renderedIdentities?: readonly SessionParticipantIdentity[];
} {
  const { participants, participantCount } = session;
  const subagentsWorking = !trailingState && session.runningChildCount > 0;
  const running = session.hasActiveRun || subagentsWorking;
  const ownRunQueued = session.hasActiveRun && session.status === "queued";
  const runState = {
    runVisibility,
    running: running && !trailingState && session.attention.kind !== "question",
    queued: ownRunQueued && !subagentsWorking,
    runningLabel:
      subagentsWorking && (!session.hasActiveRun || ownRunQueued)
        ? t("sessionsView.subagentsWorking")
        : undefined,
  };
  const graphic = session.icon ? resolveSessionIconGraphic(session.icon) : undefined;
  const iconContent =
    session.attention.kind !== "none" && !trailingState
      ? renderSessionAttentionIcon(session.attention)
      : (icon ??
        (session.icon ? (
          <span class={graphic ? "session-glyph__icon" : "session-glyph__emoji"} aria-hidden="true">
            {graphic ?? session.icon}
          </span>
        ) : undefined));
  if (iconContent !== undefined) {
    return {
      running,
      leadingIndicator: (
        <SessionGlyph
          content={iconContent}
          {...runState}
          badge={
            session.unread && !running && !trailingState ? renderSessionUnreadBadge() : undefined
          }
        />
      ),
    };
  }
  const child = session.isChild && !trailingState;
  if (child && !session.channelAvatarUrl) {
    return {
      running,
      leadingIndicator: running ? (
        <SessionGlyph content={undefined} {...runState} />
      ) : (
        renderSessionIdleState(session)
      ),
    };
  }
  const ownerChip = () =>
    !child && ownerActor?.id?.trim()
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
    return {
      running,
      leadingIndicator: (
        <SessionGlyph
          content={
            <ChannelAvatar
              routeUrl={session.channelAvatarUrl}
              authTokens={avatarAuth?.authTokens ?? []}
              authReady={avatarAuth?.authReady ?? false}
            >
              {ownerChip()}
            </ChannelAvatar>
          }
          {...runState}
          badge={
            session.unread && !running && !trailingState ? renderSessionUnreadBadge() : undefined
          }
          circular={true}
        />
      ),
    };
  }
  if (!child && ownerActor?.id?.trim()) {
    const stackedParticipants = participantCount ?? participants?.length ?? 0;
    const identities = [
      ownerActor?.identity,
      stackedParticipants === 1 ? participants?.[0]?.identity : undefined,
    ].filter((identity): identity is SessionParticipantIdentity => identity !== undefined);
    const previous = renderedOwnerIdentities.get(session);
    const renderedIdentities =
      previous?.length === identities.length &&
      identities.every((identity, index) => identity === previous[index])
        ? previous
        : identities.length
          ? identities
          : EMPTY_IDENTITIES;
    renderedOwnerIdentities.set(session, renderedIdentities);
    return {
      running,
      leadingIndicator: (
        <SessionGlyph
          content={ownerChip()}
          {...runState}
          badge={
            session.unread && !running && !trailingState ? renderSessionUnreadBadge() : undefined
          }
          circular={true}
          ring={stackedParticipants > 0 ? "pair" : "circle"}
        />
      ),
      renderedIdentities,
    };
  }
  return {
    running,
    leadingIndicator: runState.running ? (
      <SessionGlyph content={undefined} {...runState} />
    ) : session.unread && !trailingState ? (
      renderSessionIdleState(session)
    ) : undefined,
  };
}
