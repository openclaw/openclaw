import type { JSX } from "@solidjs/web";
import { For, Match, Show, Switch, createEffect, createMemo, onCleanup, untrack } from "solid-js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import {
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../../packages/gateway-protocol/src/session-agent-status.js";
import { resolveToolDisplayIcon } from "../../lib/chat/tool-display-icon.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionCreatedActor, SessionOwnerOption } from "../../lib/session-owner.ts";
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
import {
  resolveSessionRowBadges,
  type SessionRowBadgesParams,
} from "../session-row-badge-presentation.ts";
import type { resolveSidebarSessionSubtitle } from "../session-row-subtitle.ts";
import { SessionRunVisibilityController } from "../session-run-visibility-controller.ts";
import { ChannelAvatar } from "./channel-avatar.tsx";
import { Icon } from "./icon.tsx";
import { SessionOwnerAvatar, SessionOwnerChip } from "./session-owner-chip.tsx";
import "../tooltip.ts";

export type SessionRunVisibility = typeof sessionRunVisibility;
export function sessionRunVisibility(): (element: Element) => void {
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

type SessionGlyphRing = "circle" | "pair";

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
        <SessionGlyphRun
          pair={props.ring === "pair"}
          queued={props.queued}
          label={label()}
          runVisibility={props.runVisibility}
        />
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

function SessionGlyphRun(props: {
  pair: boolean;
  queued?: boolean;
  label: string;
  runVisibility?: SessionRunVisibility;
}) {
  const observe = untrack(() => props.runVisibility?.());
  let indicator: Element | undefined;
  // Class bindings can clear the offscreen class; refresh native visibility after that commit.
  createEffect(
    () => [props.queued, props.pair],
    () => {
      if (indicator) {
        observe?.(indicator);
      }
    },
  );
  return (
    <Show
      when={props.pair}
      fallback={
        <span
          ref={(element) => {
            indicator = element;
          }}
          class={["session-glyph__ring", { "session-glyph__ring--queued": props.queued }]}
          role="img"
          aria-label={props.label}
        />
      }
    >
      <svg
        class={["session-glyph__trace", { "session-glyph__trace--queued": props.queued }]}
        viewBox="-16 -11 32 22"
        role="img"
        aria-label={props.label}
      >
        <path class="session-glyph__trace-track" d={PAIR_TRACE_PATH} />
        <path
          ref={(element) => {
            indicator = element;
          }}
          class="session-glyph__trace-run"
          d={PAIR_TRACE_PATH}
          pathLength="100"
        />
      </svg>
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
      <span
        class={[
          "sidebar-recent-session__subtitle",
          { "sidebar-recent-session__subtitle--narration": Boolean(props.narration) },
        ]}
      >
        {props.subtitle}
      </span>
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
  return <SessionOwnerAvatar owner={owner} />;
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

export type TeamSessionSlotsProps = {
  rows: readonly SidebarRecentSession[];
  includeChildren: boolean;
  childCount: number;
  groupConflicts?: number;
  runVisibility?: SessionRunVisibility;
};

export function TeamSessionSlots(props: TeamSessionSlotsProps) {
  const summary = createMemo(() => {
    const attention = summarizeSidebarSessionAttention(
      props.rows.flatMap((row) =>
        props.includeChildren
          ? [row.attention]
          : [
              row.ownAttention ?? row.attention,
              ...(row.subagentSummary ? [row.subagentSummary.attention] : []),
            ],
      ),
    );
    let active = 0,
      queued = 0,
      unread = 0,
      failed = false;
    for (const row of props.rows) {
      const children = props.includeChildren ? row : row.subagentSummary;
      active += Number(row.hasActiveRun) + (children?.runningChildCount ?? 0);
      queued +=
        Number(row.hasActiveRun && row.status === "queued") + (children?.queuedChildCount ?? 0);
      unread += Number(row.unread) + (children?.unreadChildCount ?? 0);
      failed ||=
        row.status === "failed" ||
        row.status === "timeout" ||
        (children?.failedChildCount ?? 0) > 0;
    }
    return { attention, active, queued, unread, failed };
  });
  const idleChild = createMemo(() =>
    props.rows.length === 1 &&
    props.rows[0]?.isChild &&
    resolveSessionIdleBadge(props.rows[0].status, t)
      ? props.rows[0]
      : undefined,
  );
  const hasState = createMemo(
    () =>
      summary().attention.kind !== "none" ||
      summary().failed ||
      Boolean(props.groupConflicts) ||
      summary().active > 0 ||
      Boolean(idleChild()),
  );
  return (
    <Show
      when={(props.includeChildren && props.childCount > 0) || summary().unread > 0 || hasState()}
    >
      <span class="sidebar-session-team-state">
        <Show when={(props.includeChildren && props.childCount > 0) || summary().unread > 0}>
          <span class="sidebar-session-team-state__counts">
            <Show when={props.includeChildren && props.childCount > 0}>
              <span
                class="sidebar-child-session-toggle__count"
                role="img"
                aria-label={t("sessionsView.childSessions") + ": " + props.childCount}
              >
                {props.childCount}
              </span>
            </Show>
            <Show when={summary().unread > 0}>
              <span
                class={
                  summary().unread === 1 ? "session-unread-dot" : "sidebar-agent-roster__unread"
                }
                role="img"
                aria-label={t("sessionsView.unread")}
                title={t("sessionsView.unread")}
              >
                {summary().unread > 1 ? summary().unread : undefined}
              </span>
            </Show>
          </span>
        </Show>
        <Show when={hasState()}>
          <span class="sidebar-session-team-state__status">
            <Switch>
              <Match when={summary().attention.kind !== "none"}>
                <SessionAttentionIcon attention={summary().attention} />
              </Match>
              <Match when={summary().failed}>
                <span
                  class="sidebar-child-session__status--failed"
                  role="img"
                  aria-label={t("sessionsView.statusFailed")}
                >
                  <Icon name="alertTriangle" />
                </span>
              </Match>
              <Match when={props.groupConflicts}>
                <span
                  role="img"
                  aria-label={t("sessionsView.cloudWorkerDescendantConflicts", {
                    count: String(props.groupConflicts),
                  })}
                >
                  <Icon name="globe" />
                </span>
              </Match>
              <Match when={summary().active > 0}>
                <SessionGlyph
                  content={undefined}
                  running={true}
                  queued={summary().active === summary().queued}
                  runVisibility={props.runVisibility}
                />
              </Match>
              <Match when={idleChild()}>{(row) => <SessionIdleState session={row()} />}</Match>
            </Switch>
          </span>
        </Show>
      </span>
    </Show>
  );
}

export function resolveSessionIconGraphic(icon: string): JSX.Element {
  if (icon.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX)) {
    return <img src={icon} alt="" aria-hidden="true" />;
  }
  const glyph = SESSION_ICON_GLYPH_IDS.find((id) => id === icon);
  return glyph ? <Icon name={glyph} /> : undefined;
}

type SessionLeadingStateProps = {
  session: SidebarRecentSession;
  ownerActor?: SessionCreatedActor | null;
  attribution: "created" | "owned" | "archived";
  ownerViewing?: boolean;
  avatarAuth?: { authTokens: readonly string[]; authReady: boolean };
  trailingState?: boolean;
  icon?: JSX.Element;
  runVisibility?: SessionRunVisibility;
};

export function renderSessionLeadingState(props: SessionLeadingStateProps) {
  const session = () => props.session;
  const subagentsWorking = createMemo(
    () => !props.trailingState && session().runningChildCount > 0,
  );
  const running = createMemo(() => session().hasActiveRun || subagentsWorking());
  const ownRunQueued = createMemo(() => session().hasActiveRun && session().status === "queued");
  const showRun = createMemo(
    () => running() && !props.trailingState && session().attention.kind !== "question",
  );
  const runningLabel = createMemo(() =>
    subagentsWorking() && (!session().hasActiveRun || ownRunQueued())
      ? t("sessionsView.subagentsWorking")
      : undefined,
  );
  const graphic = createMemo(() =>
    session().icon ? resolveSessionIconGraphic(session().icon!) : undefined,
  );
  const iconContent = createMemo(() =>
    session().attention.kind !== "none" && !props.trailingState
      ? renderSessionAttentionIcon(session().attention)
      : (props.icon ??
        (session().icon ? (
          <span
            class={graphic() ? "session-glyph__icon" : "session-glyph__emoji"}
            aria-hidden="true"
          >
            {graphic() ?? session().icon}
          </span>
        ) : undefined)),
  );
  const child = createMemo(() => session().isChild && !props.trailingState);
  const hasOwner = createMemo(() => !child() && Boolean(props.ownerActor?.id?.trim()));
  const ownerChip = () =>
    hasOwner()
      ? renderSessionOwnerChip(
          props.ownerActor,
          "row",
          props.attribution,
          props.ownerViewing,
          session().participants,
          session().participantCount,
        )
      : undefined;
  const stackedParticipants = createMemo(
    () => session().participantCount ?? session().participants?.length ?? 0,
  );
  const renderedIdentities = createMemo(() => {
    if (iconContent() !== undefined || session().channelAvatarUrl || !hasOwner()) {
      return undefined;
    }
    return [
      props.ownerActor?.identity,
      stackedParticipants() === 1 ? session().participants?.[0]?.identity : undefined,
    ].filter((identity): identity is SessionParticipantIdentity => identity !== undefined);
  });
  const showGlyph = createMemo(
    () =>
      iconContent() !== undefined ||
      (child() && !session().channelAvatarUrl
        ? running()
        : Boolean(session().channelAvatarUrl) || hasOwner() || showRun()),
  );
  const content = createMemo(() => {
    if (iconContent() !== undefined) {
      return iconContent();
    }
    if (session().channelAvatarUrl) {
      return (
        <ChannelAvatar
          routeUrl={session().channelAvatarUrl!}
          authTokens={props.avatarAuth?.authTokens ?? []}
          authReady={props.avatarAuth?.authReady ?? false}
        >
          {ownerChip()}
        </ChannelAvatar>
      );
    }
    return ownerChip();
  });
  // Keep the glyph mounted while session facts change so its CSS animation keeps its timeline.
  const leadingIndicator = (
    <Show
      when={showGlyph()}
      fallback={
        <Show when={!props.trailingState}>
          <SessionIdleState session={session()} />
        </Show>
      }
    >
      <SessionGlyph
        content={content()}
        running={showRun()}
        queued={ownRunQueued() && !subagentsWorking()}
        runningLabel={runningLabel()}
        runVisibility={props.runVisibility}
        circular={iconContent() === undefined && Boolean(session().channelAvatarUrl || hasOwner())}
        ring={
          iconContent() === undefined &&
          !session().channelAvatarUrl &&
          hasOwner() &&
          stackedParticipants() > 0
            ? "pair"
            : "circle"
        }
        badge={
          session().unread &&
          !running() &&
          !props.trailingState &&
          !(iconContent() === undefined && child() && !session().channelAvatarUrl)
            ? renderSessionUnreadBadge()
            : undefined
        }
      />
    </Show>
  );
  return {
    get running() {
      return running();
    },
    leadingIndicator,
    get visible() {
      return (
        showGlyph() ||
        (!props.trailingState &&
          (session().isChild
            ? Boolean(resolveSessionIdleBadge(session().status, t))
            : session().unread))
      );
    },
    get renderedIdentities() {
      return renderedIdentities();
    },
  };
}
