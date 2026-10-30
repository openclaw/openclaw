import type { JSX } from "@solidjs/web";
import { Match, Show, Switch, createMemo, createSignal } from "solid-js";
import type {
  SessionParticipant,
  SessionParticipantIdentity,
} from "../../../../packages/gateway-protocol/src/schema/session-participant.js";
import {
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../../packages/gateway-protocol/src/session-agent-status.js";
import { registerChatToolLabelsEnglish } from "../../i18n/locales/en-chat-tool-labels.ts";
import { resolveToolDisplayIcon } from "../../lib/chat/tool-display-icon.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
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
import { createSessionRunVisibility as sessionRunVisibility } from "../session-run-visibility-controller.ts";
import { ChannelAvatar } from "./channel-avatar.tsx";
import "../tooltip.ts";
import { Icon, sessionIcon, sessionIconMask } from "./icon.tsx";
import { SessionOwnerAvatar, SessionOwnerChip } from "./session-owner-chip.tsx";

registerEnglishCatalog(registerChatToolLabelsEnglish);

type SessionRunVisibility = typeof sessionRunVisibility;
export { sessionRunVisibility };

function SessionAttentionIcon(props: { attention: SidebarSessionAttention; size: number }) {
  const parts = createMemo(() => sessionAttentionTooltipParts(props.attention, t));
  const label = () =>
    [parts().status, parts().preview, parts().more].filter(Boolean).join("\n") || undefined;
  const icon = () => sessionAttentionIconName(props.attention);
  return (
    <Show when={props.attention.kind !== "none"}>
      {/* Sidebar rows sit against the app rail; open inline to the right so the
          tooltip never clamps over the rail or the row's own title. */}
      <openclaw-tooltip
        prop:content={parts().preview ? "" : parts().status}
        prop:placement="right"
        open-on-click
      >
        <span
          class={[
            "sidebar-session-attention__icon",
            `sidebar-session-attention__icon--${props.attention.kind}`,
            {
              "sidebar-session-attention__icon--inherited":
                props.attention.kind === "error" && props.attention.childLabel !== undefined,
            },
          ]}
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
          {sessionIcon(icon(), props.size, 1.75)}
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
const PAIR_TRACE_PATH = "M0 -9.165A10 10 0 1 1 0 9.165A10 10 0 1 1 0 -9.165Z";
export function SessionGlyph(props: {
  content: JSX.Element;
  running: boolean;
  queued?: boolean;
  runningLabel?: string;
  circular?: boolean;
  badge?: JSX.Element;
  ring?: "circle" | "pair";
  runVisibility?: SessionRunVisibility;
}) {
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
      <Show when={props.running && (props.runVisibility ?? true)} keyed>
        {(createVisibility) => {
          const [offscreen, setOffscreen] = createSignal(false);
          const observe = (typeof createVisibility === "function" ? createVisibility : undefined)?.(
            setOffscreen,
          );
          return (
            <Show
              when={props.ring === "pair"}
              fallback={
                <span
                  ref={(element) => observe?.(element)}
                  class={[
                    "session-glyph__ring",
                    {
                      "session-glyph__ring--queued": props.queued,
                      "session-run-indicator--offscreen": offscreen(),
                    },
                  ]}
                  role="img"
                  aria-label={label()}
                />
              }
            >
              <svg
                class={["session-glyph__trace", { "session-glyph__trace--queued": props.queued }]}
                viewBox="-16 -11 32 22"
                role="img"
                aria-label={label()}
              >
                <path class="session-glyph__trace-track" d={PAIR_TRACE_PATH} />
                <path
                  ref={(element) => observe?.(element)}
                  class={[
                    "session-glyph__trace-run",
                    { "session-run-indicator--offscreen": offscreen() },
                  ]}
                  d={PAIR_TRACE_PATH}
                  pathLength="100"
                />
              </svg>
            </Show>
          );
        }}
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
  const rendered = createMemo<{ facts: string; node?: HTMLElement }>((previous) => {
    const badges = resolveSessionRowBadges(props, t);
    const facts = JSON.stringify(badges);
    if (previous?.facts === facts) {
      return previous;
    }
    if (!badges.length) {
      return { facts };
    }
    const group = document.createElement("span");
    group.className = "session-row-badges";
    for (const badge of badges) {
      const element = document.createElement("span");
      element.classList.add("session-row-badge", `session-row-badge--${badge.modifier}`);
      element.title = badge.label;
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", badge.label);
      for (const [key, value] of Object.entries({
        "pull-request-state": badge.pullRequestState,
        "placement-state": badge.placementState,
        "disk-space-status": badge.diskSpaceStatus,
        "workspace-conflicts": badge.workspaceConflictCount || undefined,
      })) {
        if (value !== undefined) {
          element.setAttribute(`data-${key}`, String(value));
        }
      }
      element.append(sessionIcon(badge.icon, 14, 1.6));
      const countText = badge.countLabel ?? (badge.count ? String(badge.count) : undefined);
      if (countText) {
        const count = document.createElement("span");
        count.setAttribute("aria-hidden", "true");
        count.textContent = countText;
        element.append(count);
      }
      group.append(element);
    }
    return { facts, node: group };
  });
  return <>{rendered().node}</>;
}

export function SidebarSessionSubtitle(props: ReturnType<typeof resolveSidebarSessionSubtitle>) {
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
            class={[
              "sidebar-child-session__status",
              `sidebar-child-session__status--${props.session.status}`,
            ]}
            role="img"
            aria-label={current().label}
            title={current().label}
          >
            {sessionIcon(current().icon, 14, 1.75)}
          </span>
        )}
      </Show>
    </Show>
  );
}

export function summarizeTeamSessionSlots(
  rows: readonly SidebarRecentSession[],
  includeChildren: boolean,
) {
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
    const visuallyActive = row.isRunVisuallyActive ?? row.hasActiveRun;
    active += Number(visuallyActive) + (children?.runningChildCount ?? 0);
    queued += Number(visuallyActive && row.status === "queued") + (children?.queuedChildCount ?? 0);
    unread += Number(row.unread) + (children?.unreadChildCount ?? 0);
    failed ||=
      row.status === "failed" || row.status === "timeout" || (children?.failedChildCount ?? 0) > 0;
  }
  return { attention, active, queued, unread, failed };
}

export type TeamSessionSlotsProps = {
  rows: readonly SidebarRecentSession[];
  includeChildren: boolean;
  childCount: number;
  groupConflicts?: number;
  runVisibility?: SessionRunVisibility;
  statusOnly?: boolean;
};

export function TeamSessionSlots(props: TeamSessionSlotsProps) {
  const summary = createMemo(() => summarizeTeamSessionSlots(props.rows, props.includeChildren));
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
      (!props.statusOnly && (summary().active > 0 || Boolean(idleChild()))),
  );
  return (
    <Show
      when={(!props.statusOnly && (props.childCount > 0 || summary().unread > 0)) || hasState()}
    >
      <span class="sidebar-session-team-state">
        <Show when={!props.statusOnly && (props.childCount > 0 || summary().unread > 0)}>
          <span class="sidebar-session-team-state__counts">
            <Show when={props.childCount > 0}>
              <span
                class="sidebar-child-session-toggle__count"
                role="img"
                aria-label={t("sessionsView.childSessions") + ": " + props.childCount}
              >
                {sessionIcon("gitFork")}
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
                <SessionAttentionIcon attention={summary().attention} size={12} />
              </Match>
              <Match when={summary().failed}>
                <span
                  class="sidebar-child-session__status--failed"
                  role="img"
                  aria-label={t("sessionsView.statusFailed")}
                >
                  {sessionIcon("alertTriangle")}
                </span>
              </Match>
              <Match when={props.groupConflicts}>
                <span
                  role="img"
                  aria-label={t("sessionsView.cloudWorkerDescendantConflicts", {
                    count: String(props.groupConflicts),
                  })}
                >
                  {sessionIcon("globe")}
                </span>
              </Match>
              <Match when={!props.statusOnly && summary().active > 0}>
                <SessionGlyph
                  content={undefined}
                  running={true}
                  queued={summary().active === summary().queued}
                  runVisibility={props.runVisibility}
                />
              </Match>
              <Match when={!props.statusOnly && idleChild()}>
                {(row) => <SessionIdleState session={row()} />}
              </Match>
            </Switch>
          </span>
        </Show>
      </span>
    </Show>
  );
}

function SessionIcon(props: { icon: string }) {
  const glyph = createMemo(() => SESSION_ICON_GLYPH_IDS.find((id) => id === props.icon));
  const image = createMemo(() => props.icon.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX));
  return (
    <span
      class={image() || glyph() ? "session-glyph__icon" : "session-glyph__emoji"}
      aria-hidden="true"
    >
      <Switch fallback={props.icon}>
        <Match when={image()}>
          <img src={props.icon} alt="" aria-hidden="true" />
        </Match>
        <Match when={glyph()}>
          {(name) => (
            <i
              class="session-css-icon"
              aria-hidden="true"
              style={{ "mask-image": sessionIconMask(name(), 1.75) }}
            />
          )}
        </Match>
      </Switch>
    </span>
  );
}

export function renderSessionLeadingState(props: {
  session: SidebarRecentSession;
  ownerActor?: SessionCreatedActor | null;
  attribution: "created" | "owned" | "archived";
  ownerViewing?: boolean;
  avatarAuth?: { authTokens: readonly string[]; authReady: boolean };
  trailingState?: boolean;
  icon?: JSX.Element;
  runVisibility?: SessionRunVisibility;
}) {
  const session = () => props.session;
  const subagentsWorking = createMemo(
    () => !props.trailingState && session().runningChildCount > 0,
  );
  const ownRunActive = () => session().isRunVisuallyActive ?? session().hasActiveRun;
  const running = createMemo(() => ownRunActive() || subagentsWorking());
  const ownRunQueued = createMemo(() => ownRunActive() && session().status === "queued");
  const showRun = createMemo(
    () => running() && !props.trailingState && session().attention.kind !== "question",
  );
  const runningLabel = createMemo(() =>
    subagentsWorking() && (!ownRunActive() || ownRunQueued())
      ? t("sessionsView.subagentsWorking")
      : undefined,
  );
  const icon = createMemo(() => session().icon);
  const attentionIcon = createMemo(
    () => session().attention.kind !== "none" && !props.trailingState,
  );
  const hasIcon = createMemo(() => attentionIcon() || props.icon != null || Boolean(icon()));
  const child = createMemo(() => session().isChild && !props.trailingState);
  const hasOwner = createMemo(() => !child() && Boolean(props.ownerActor?.id?.trim()));
  const OwnerChip = () => (
    <Show when={hasOwner()}>
      <SessionOwnerChip
        owner={props.ownerActor}
        size="row"
        attribution={props.attribution}
        viewingNow={props.ownerViewing}
        participants={session().participants ?? []}
        participantCount={session().participantCount ?? session().participants?.length ?? 0}
      />
    </Show>
  );
  const channelAvatarUrl = createMemo(() => session().channelAvatarUrl);
  const stackedParticipants = createMemo(
    () => session().participantCount ?? session().participants?.length ?? 0,
  );
  const renderedIdentities = createMemo(() => {
    if (hasIcon() || channelAvatarUrl() || !hasOwner()) {
      return undefined;
    }
    return [
      props.ownerActor?.identity,
      stackedParticipants() === 1 ? session().participants?.[0]?.identity : undefined,
    ].filter((identity): identity is SessionParticipantIdentity => identity !== undefined);
  });
  const hasContent = createMemo(
    () =>
      (attentionIcon() || props.icon !== false) &&
      (hasIcon() || Boolean(channelAvatarUrl()) || hasOwner()),
  );
  const showGlyph = createMemo(
    () =>
      hasIcon() ||
      (child() && !channelAvatarUrl()
        ? running()
        : Boolean(channelAvatarUrl()) || hasOwner() || showRun()),
  );
  const content = (
    <Switch fallback={<OwnerChip />}>
      <Match when={attentionIcon()}>
        <SessionAttentionIcon attention={session().attention} size={15} />
      </Match>
      <Match when={props.icon != null}>{props.icon}</Match>
      <Match when={Boolean(icon())}>
        <SessionIcon icon={icon()!} />
      </Match>
      <Match when={Boolean(channelAvatarUrl())}>
        <ChannelAvatar
          routeUrl={channelAvatarUrl()!}
          authTokens={props.avatarAuth?.authTokens ?? []}
          authReady={props.avatarAuth?.authReady ?? false}
        >
          <OwnerChip />
        </ChannelAvatar>
      </Match>
    </Switch>
  );
  const unreadBadge = createMemo(
    () =>
      session().unread &&
      !running() &&
      !props.trailingState &&
      !(!hasIcon() && child() && !channelAvatarUrl()),
  );
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
        content={hasContent() ? content : undefined}
        running={showRun()}
        queued={ownRunQueued() && !subagentsWorking()}
        runningLabel={runningLabel()}
        runVisibility={props.runVisibility}
        circular={!hasIcon() && Boolean(channelAvatarUrl() || hasOwner())}
        ring={
          !hasIcon() && !channelAvatarUrl() && hasOwner() && stackedParticipants() > 0
            ? "pair"
            : "circle"
        }
        badge={<Show when={unreadBadge()}>{renderSessionUnreadBadge()}</Show>}
      />
    </Show>
  );
  return {
    running,
    leadingIndicator,
    renderedIdentities,
  };
}
