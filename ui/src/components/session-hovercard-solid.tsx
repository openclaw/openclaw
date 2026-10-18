import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createMemo, For, Show, untrack } from "solid-js";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { t } from "../i18n/index.ts";
import { registerGitHubEnglish } from "../i18n/locales/en-github.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { PersonAvatarLink, PersonName } from "./person-activity-link-solid.tsx";
import { personActivityLink, type PersonActivityRouting } from "./person-activity-link.ts";
import { sessionAttentionSubtitle } from "./session-attention-presentation.ts";
import {
  SessionHovercardContext,
  type SessionHovercardContextInput,
} from "./session-hovercard-context-solid.tsx";
import { participantLabel, formatSessionAge, sessionAttribution } from "./session-hovercard.ts";
import { sessionOwnerInitials } from "./session-owner-chip.ts";
import { ProgressCardMarkdown } from "./session-progress-card-view.tsx";
import { progressCardHeadsUp } from "./session-progress-card.ts";
import { ChannelAvatar } from "./solid/channel-avatar.tsx";
import { Icon } from "./solid/icon.tsx";
import { ViewerAvatar } from "./solid/viewer-facepile.tsx";
import "./session-hovercard.css";
import "./tooltip.ts";

registerGitHubEnglish();

const MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS = 4;
type SessionHovercardAvatarAuth = { authTokens: readonly string[]; authReady: boolean };
export type SessionHovercardInput = SessionHovercardContextInput & {
  selfUserId?: string;
  avatarAuth?: SessionHovercardAvatarAuth;
  personActivity?: PersonActivityRouting;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  progressCard?: ProgressCard | null;
};
const PULL_REQUEST_STATE_ICONS = {
  open: "gitPullRequest",
  draft: "gitPullRequestDraft",
  merged: "gitMerge",
  closed: "gitPullRequestClosed",
} as const;

function DiffStats(props: { item: { additions?: number; deletions?: number } }) {
  return (
    <Show when={props.item.additions !== undefined || props.item.deletions !== undefined}>
      <span class="session-hovercard__diff">
        <For each={["additions", "deletions"] as const}>
          {(kind) => (
            <Show when={props.item[kind] !== undefined}>
              <span class={`session-hovercard__${kind}`}>
                {kind === "additions" ? "+" : "−"}
                {props.item[kind]?.toLocaleString()}
              </span>
            </Show>
          )}
        </For>
      </span>
    </Show>
  );
}

function ParticipantLink(props: {
  participant: SessionParticipant;
  routing?: PersonActivityRouting;
}) {
  const label = () => participantLabel(props.participant);
  const activity = () =>
    props.participant.identity.type === "profile"
      ? personActivityLink(props.participant.identity.id, props.routing, label())
      : null;
  return (
    <div role="listitem">
      <PersonName
        label={label()}
        link={activity()}
        class="session-menu__item learn-more-link session-hovercard__participant-link"
      />
    </div>
  );
}

function ParticipantMenu(props: {
  participants: readonly SessionParticipant[];
  count: number;
  routing?: PersonActivityRouting;
}) {
  const unresolved = () => Math.max(0, props.count - props.participants.length);
  return (
    <div
      slot="content"
      class="session-hovercard__participant-menu"
      role="list"
      style={{ "min-width": "150px", "max-height": "min(280px, 60vh)", "overflow-y": "auto" }}
      aria-label={t("sessionHovercard.moreParticipantsLabel", { count: String(props.count) })}
    >
      <For each={props.participants} keyed={(participant) => JSON.stringify(participant.identity)}>
        {(participant) => <ParticipantLink participant={participant()} routing={props.routing} />}
      </For>
      <Show when={unresolved() > 0}>
        <div class="session-hovercard__more" role="listitem">
          {t("sessionHovercard.moreParticipantsLabel", { count: String(unresolved()) })}
        </div>
      </Show>
    </div>
  );
}

type Attribution = NonNullable<ReturnType<typeof sessionAttribution>>;

function AttributionContent(props: {
  attribution: Attribution;
  row?: SidebarSessionHovercardRow;
  auth?: SessionHovercardAvatarAuth;
  routing?: PersonActivityRouting;
}) {
  const creatorInitials = createMemo(() => {
    const creator = props.attribution.creator;
    return creator ? sessionOwnerInitials(creator) : "";
  });
  const primaryActivity = () =>
    props.attribution.primaryIdentity?.type === "profile"
      ? personActivityLink(
          props.attribution.primaryIdentity.id,
          props.routing,
          props.attribution.primaryLabel,
        )
      : null;
  const avatarPerson = () =>
    props.attribution.creator ??
    (props.attribution.participants[0]
      ? { ...props.attribution.participants[0], id: props.attribution.participants[0].identity.id }
      : undefined);
  const remaining = createMemo(() =>
    props.attribution.creator
      ? props.attribution.participants
      : props.attribution.participants.slice(1),
  );
  const otherLabel = () =>
    props.attribution.otherCount > 0
      ? t(
          props.attribution.otherCount === 1
            ? "sessionHovercard.attributionOther"
            : "sessionHovercard.attributionOthers",
          { count: String(props.attribution.otherCount) },
        )
      : "";
  const attributionLabel = () =>
    [
      props.attribution.primaryLabel,
      props.attribution.otherCount > 0
        ? t("sessionHovercard.moreParticipantsLabel", {
            count: String(props.attribution.otherCount),
          })
        : "",
    ]
      .filter(Boolean)
      .join(", ");
  return (
    <div class="session-hovercard__attribution" aria-label={attributionLabel()}>
      <span class="session-hovercard__attribution-copy">
        <PersonName
          label={props.attribution.primaryLabel}
          link={primaryActivity()}
          class="session-hovercard__attribution-name"
        />
        <Show when={props.attribution.otherCount > 0}>
          <Show
            when={remaining().length > 0}
            fallback={<span class="session-hovercard__attribution-others">{otherLabel()}</span>}
          >
            <openclaw-tooltip
              class="session-hovercard__participants-tooltip"
              prop:describe={false}
              open-on-click
            >
              <button
                type="button"
                class="session-hovercard__attribution-others"
                style={{
                  padding: "1px 3px",
                  border: "0",
                  "border-radius": "var(--radius-sm)",
                  background: "transparent",
                  font: "inherit",
                }}
                aria-label={t("sessionHovercard.moreParticipantsLabel", {
                  count: String(props.attribution.otherCount),
                })}
              >
                {otherLabel()}
              </button>
              <ParticipantMenu
                participants={remaining()}
                count={props.attribution.otherCount}
                routing={props.routing}
              />
            </openclaw-tooltip>
          </Show>
        </Show>
      </span>
      <span class="session-hovercard__attribution-avatars">
        <PersonAvatarLink link={primaryActivity()}>
          <Show
            when={Boolean(props.attribution.creator && props.row?.channelAvatarUrl)}
            fallback={
              <Show when={avatarPerson()}>
                {(person) => {
                  const initial = untrack(person);
                  const current = () => avatarPerson() ?? initial;
                  return (
                    <ViewerAvatar
                      class="session-hovercard__creator-avatar"
                      user={{
                        id: current().id ?? current().identity?.id ?? "",
                        name: current().label,
                        avatarUrl: current().avatarUrl,
                        watchedSessions: [],
                      }}
                      markAsViewer={false}
                      identity={current().identity}
                      variant="session"
                      aria-hidden="true"
                    />
                  );
                }}
              </Show>
            }
          >
            <ChannelAvatar
              class="session-hovercard__creator-avatar"
              routeUrl={props.row?.channelAvatarUrl}
              authTokens={props.auth?.authTokens ?? []}
              authReady={props.auth?.authReady ?? false}
              aria-hidden="true"
            >
              <Show when={creatorInitials()}>
                <span class="session-hovercard__creator-avatar-fallback" aria-hidden="true">
                  {creatorInitials()}
                </span>
              </Show>
            </ChannelAvatar>
          </Show>
        </PersonAvatarLink>
        <Show when={remaining().length > 0}>
          <openclaw-viewer-facepile
            prop:staticParticipants={remaining()}
            prop:totalCount={props.attribution.otherCount}
            prop:maxVisible={Math.min(remaining().length, MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS)}
            prop:personActivity={props.routing}
          />
        </Show>
      </span>
    </div>
  );
}

function SessionAttribution(props: SessionHovercardInput) {
  const attribution = createMemo(() =>
    props.row ? sessionAttribution(props.row, props.selfUserId) : undefined,
  );
  return (
    <Show when={attribution()}>
      {(current) => {
        const initial = untrack(current);
        return (
          <AttributionContent
            attribution={attribution() ?? initial}
            row={props.row}
            auth={props.avatarAuth}
            routing={props.personActivity}
          />
        );
      }}
    </Show>
  );
}

function Header(props: SessionHovercardInput & { row: SidebarSessionHovercardRow }) {
  const channel = () => props.row.channelPresentation;
  const details = createMemo(() =>
    channel()
      ? [
          ...new Set(
            [channel()?.conversation, channel()?.address].filter(
              (value) => value && value !== props.row.label,
            ),
          ),
        ]
      : [],
  );
  const age = () => formatSessionAge(props.row.createdAt, false);
  return (
    <header class="session-hovercard__header">
      <span class="session-hovercard__heading">
        <Show when={channel()}>
          {(current) => {
            const initial = untrack(current);
            return (
              <span class="session-hovercard__channel">
                <span aria-hidden="true">
                  <Icon name="link" />
                </span>
                {t("sessionHovercard.linkedChannel", {
                  channel: (channel() ?? initial).channelLabel,
                })}
              </span>
            );
          }}
        </Show>
        <span class="session-hovercard__title">
          <SessionColorDot color={props.row.color} />
          {props.row.label}
        </span>
        <Show
          when={channel()}
          fallback={
            <SessionAttribution
              row={props.row}
              selfUserId={props.selfUserId}
              avatarAuth={props.avatarAuth}
              personActivity={props.personActivity}
            />
          }
        >
          {(current) => {
            const initial = untrack(current);
            const value = () => channel() ?? initial;
            return (
              <span class="session-hovercard__conversation">
                <Show when={value().kind}>
                  <span>
                    {value().topicId
                      ? t("sessionHovercard.topicNumber", { id: value().topicId! })
                      : t(`sessionHovercard.chatKinds.${value().kind}`)}
                  </span>
                </Show>
                <For each={details()}>{(detail) => <span>{detail}</span>}</For>
                <Show when={value().account}>
                  <span>{t("sessionHovercard.viaAccount", { account: value().account! })}</span>
                </Show>
              </span>
            );
          }}
        </Show>
      </span>
      <Show when={age()}>
        <span
          class="session-hovercard__created-age"
          title={formatSessionAge(props.row.createdAt, true)}
        >
          {age()}
        </span>
      </Show>
    </header>
  );
}

function PullRequestRow(props: { request: ControlUiSessionPullRequest }) {
  const state = () => t(`sessionHovercard.states.${props.request.state}`);
  const checks = () =>
    props.request.checks ? t(`sessionHovercard.checks.${props.request.checks.state}`) : null;
  const details = () =>
    [
      props.request.title,
      checks(),
      props.request.additions === undefined ? null : `+${props.request.additions.toLocaleString()}`,
      props.request.deletions === undefined ? null : `−${props.request.deletions.toLocaleString()}`,
    ].filter((detail): detail is string => Boolean(detail));
  const stateLabel = () => (checks() ? `${state()} · ${checks()}` : state());
  return (
    <a
      class="session-hovercard__pr-row"
      data-state={props.request.state}
      href={props.request.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${t("sessionHovercard.pullRequestLabel", { number: String(props.request.number), state: state() })}${details().length > 0 ? `, ${details().join(", ")}` : ""}`}
    >
      <span
        class="session-hovercard__pr-state-icon"
        role="img"
        data-checks={props.request.checks?.state}
        aria-label={stateLabel()}
        title={stateLabel()}
      >
        <Icon name={PULL_REQUEST_STATE_ICONS[props.request.state]} />
      </span>
      <span class="session-hovercard__pr-title">{props.request.title}</span>
      <DiffStats item={props.request} />
    </a>
  );
}

function PullRequestDetails(props: { snapshot?: ControlUiSessionPullRequestSnapshot }) {
  const branch = () => props.snapshot?.branch;
  const branchLabel = () =>
    t("chat.pullRequests.createPrLabel", { branch: branch()?.branch ?? "" });
  return (
    <Show
      when={(props.snapshot?.pullRequests.length ?? 0) > 0}
      fallback={
        <Show when={branch()}>
          <div class="session-hovercard__branch-row">
            <span class="session-hovercard__branch-icon" aria-hidden="true">
              <Icon name="gitBranch" />
            </span>
            <Show
              when={branch()?.createUrl}
              fallback={
                <span class="session-hovercard__branch-label">{t("chat.sessionDiff.title")}</span>
              }
            >
              <a
                class="session-hovercard__branch-action"
                href={branch()?.createUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={branchLabel()}
                title={branchLabel()}
              >
                {t("chat.pullRequests.createPr")}
              </a>
            </Show>
            <DiffStats item={branch() ?? {}} />
          </div>
        </Show>
      }
    >
      <div class="session-hovercard__pr-list">
        <For each={props.snapshot?.pullRequests.slice(0, 1)} keyed={(request) => request.url}>
          {(request) => <PullRequestRow request={request()} />}
        </For>
        <Show when={(props.snapshot?.pullRequests.length ?? 0) > 1}>
          <span class="session-hovercard__more">
            {t("sessionHovercard.more", {
              count: String((props.snapshot?.pullRequests.length ?? 0) - 1),
            })}
          </span>
        </Show>
      </div>
    </Show>
  );
}

function SessionColorDot(props: { color: string | null | undefined }) {
  const color = () => normalizeSessionColorValue(props.color ?? "");
  return (
    <Show when={color()}>
      {(current) => {
        const initial = untrack(current);
        const value = () => color() ?? initial;
        return (
          <span
            class="session-color-dot"
            style={{ "--session-color": `var(--session-color-${value()})` }}
            role="img"
            aria-label={t("sessionsView.sessionColor", {
              color: t(`sessionsView.colors.${value()}`),
            })}
          />
        );
      }}
    </Show>
  );
}

export function SessionHovercard(props: SessionHovercardInput) {
  const headsUp = createMemo(() =>
    progressCardHeadsUp(
      props.progressCard,
      props.row?.status,
      props.row?.startedAt,
      props.row?.hasActiveRun ?? false,
    ),
  );
  const hasPullRequests = () =>
    Boolean(
      props.pullRequests &&
      (props.pullRequests.pullRequests.length > 0 ||
        props.pullRequests.branch ||
        props.pullRequests.status !== "ready"),
    );
  const hasContext = () =>
    Boolean(
      props.row?.workContext ||
      (props.row?.placementProviderId && props.row?.placementProfileId) ||
      props.row?.boardFace === "dashboard" ||
      (props.row?.hasAutomation && props.automationLink) ||
      headsUp(),
    );
  const preview = () =>
    props.progressCard ? undefined : props.row?.lastMessagePreview?.trim() || undefined;
  return (
    <Show when={Boolean(props.row || hasPullRequests() || props.progressCard)}>
      <div class="session-hovercard">
        <Show when={props.row}>
          {(row) => {
            // Retiring descendants can read after the parent clears its row.
            const initial = untrack(row);
            return (
              <section class="session-hovercard__section session-hovercard__section--header">
                <Header
                  row={props.row ?? initial}
                  selfUserId={props.selfUserId}
                  avatarAuth={props.avatarAuth}
                  personActivity={props.personActivity}
                />
              </section>
            );
          }}
        </Show>
        <Show when={hasContext()}>
          <section class="session-hovercard__section session-hovercard__section--metadata">
            <SessionHovercardContext
              row={props.row}
              automationLink={props.automationLink}
              headsUp={headsUp()}
            />
          </section>
        </Show>
        <Show when={hasPullRequests()}>
          <section class="session-hovercard__section session-hovercard__section--prs">
            <PullRequestDetails snapshot={props.pullRequests} />
            <Show when={props.pullRequests?.status !== "ready"}>
              <div class="session-hovercard__more" role="status">
                {t(
                  props.pullRequests?.status === "rate-limited"
                    ? "chat.pullRequests.rateLimited"
                    : "chat.pullRequests.unavailable",
                )}
              </div>
            </Show>
          </section>
        </Show>
        <Show when={preview()}>
          <section class="session-hovercard__section session-hovercard__section--optional">
            <div class="session-hovercard__excerpt">{preview()}</div>
          </section>
        </Show>
        <Show when={props.row?.attention?.kind === "error"}>
          <section class="session-hovercard__section session-hovercard__error">
            <span class="session-hovercard__error-icon" aria-hidden="true">
              <Icon name="alertTriangle" />
            </span>
            <span>{props.row?.attention ? sessionAttentionSubtitle(props.row.attention) : ""}</span>
          </section>
        </Show>
        <Show when={props.progressCard?.markdown?.trim()}>
          <section
            class="session-hovercard__section session-hovercard__notepad"
            aria-label={t("sessionHovercard.agentNotepad")}
          >
            <div class="session-hovercard__notepad-title">{t("sessionHovercard.agentNotepad")}</div>
            <ProgressCardMarkdown markdown={props.progressCard?.markdown} promoteProgress />
          </section>
        </Show>
        <Show
          when={props.row?.channelPresentation && sessionAttribution(props.row, props.selfUserId)}
        >
          <section
            class="session-hovercard__section session-hovercard__section--attribution"
            aria-label={t("sessionHovercard.sessionParticipants")}
          >
            <div class="session-hovercard__attribution-label">
              {t("sessionHovercard.sessionParticipants")}
            </div>
            <SessionAttribution
              row={props.row}
              selfUserId={props.selfUserId}
              avatarAuth={props.avatarAuth}
              personActivity={props.personActivity}
            />
          </section>
        </Show>
      </div>
    </Show>
  );
}
