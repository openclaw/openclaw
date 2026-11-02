import type { ProgressCard } from "@openclaw/gateway-protocol";
import type { JSX } from "@solidjs/web";
import { createMemo, For, Show, useContext } from "solid-js";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type {
  ControlUiSessionBranch,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { registerGitHubEnglish } from "../i18n/locales/en-github.ts";
import { registerSessionProgressEnglish } from "../i18n/locales/en-session-progress.ts";
import { i18nRevision, registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { sessionOwnerInitials } from "../lib/session-owner.ts";
import {
  displaySessionPullRequests,
  sessionPullRequestStateIcons,
  type SessionDisplayPullRequest,
} from "../lib/session-pull-request-presentation.ts";
import type { SidebarSessionHovercardRow } from "./app-sidebar-session-types.ts";
import { formatGitHubItemReference } from "./github-link-target.ts";
import { PersonAvatarLink, PersonName } from "./person-activity-link-solid.tsx";
import { personActivityLink, type PersonActivityRouting } from "./person-activity-link.ts";
import { createHovercardControlRef, HovercardControlsContext } from "./portaled-hovercard-focus.ts";
import { sessionAttentionSubtitle } from "./session-attention-presentation.ts";
import { SessionGitDiff } from "./session-git-diff.tsx";
import {
  participantLabel,
  formatSessionAge,
  sessionAttribution,
  writeHovercardExcerpt,
} from "./session-hovercard.ts";
import { ProgressCardMarkdown } from "./session-progress-card-view.tsx";
import { progressCardHeadsUp } from "./session-progress-card.ts";
import { ChannelAvatar } from "./solid/channel-avatar.tsx";
import { Icon } from "./solid/icon.tsx";
import { ViewerAvatar, ViewerFacepile } from "./solid/viewer-facepile.tsx";
import "./session-hovercard.css";
import "./tooltip.ts";

registerEnglishCatalog(registerSessionProgressEnglish);

function ContextRow(props: {
  icon: JSX.Element;
  value: JSX.Element;
  label: string;
  title?: string;
  end?: JSX.Element;
}) {
  return (
    <div class="session-hovercard__context-row" aria-label={props.label} title={props.title}>
      <span class="session-hovercard__context-icon" aria-hidden="true">
        {props.icon}
      </span>
      <span class="session-hovercard__context-value session-hovercard__context-text">
        {props.value}
      </span>
      {props.end}
    </div>
  );
}

function ProgressHeadsUp(props: { headsUp: ReturnType<typeof progressCardHeadsUp> }) {
  const statusLabel = () =>
    t(
      props.headsUp?.status === "in_progress"
        ? "sessionProgressCard.status.inProgress"
        : props.headsUp?.status === "paused"
          ? "sessionProgressCard.status.paused"
          : "sessionProgressCard.status.pending",
    );
  return (
    <Show when={props.headsUp}>
      <div
        class="session-hovercard__context-row session-hovercard__plan-row"
        aria-label={t("sessionProgressCard.stepLabel", {
          status: statusLabel(),
          step: props.headsUp?.step ?? "",
        })}
        title={props.headsUp?.step}
      >
        <span class="session-hovercard__context-icon" aria-hidden="true">
          <Show when={props.headsUp?.status === "in_progress"} fallback={<Icon name="clock" />}>
            <span class="session-run-spinner" />
          </Show>
        </span>
        <span class="session-hovercard__context-value session-hovercard__plan-step">
          {props.headsUp?.step}
        </span>
        <span class="session-hovercard__plan-count">
          {props.headsUp?.completed}/{props.headsUp?.total}
        </span>
      </div>
    </Show>
  );
}

function SessionHovercardContext(props: {
  row?: SidebarSessionHovercardRow;
  branch?: ControlUiSessionBranch;
  showChanges: boolean;
}) {
  const context = () => props.row?.workContext;
  const contextLabel = () =>
    t(
      context()?.kind === "project"
        ? "sessionHovercard.projectLabel"
        : "sessionHovercard.workspaceLabel",
    );
  const directory = () => {
    const current = context();
    return current?.kind === "project" ? current.cwd : current?.path;
  };
  const projectLocation = () => directory() ?? context()?.path;
  const name = () => context()?.name ?? props.branch?.repo;
  const branch = () => {
    const current = context();
    return (current?.kind === "project" ? current.branch : undefined) ?? props.branch?.branch;
  };
  const locationLabel = () =>
    [
      `${contextLabel()}: ${name() ?? ""}`,
      branch() ? `${t("sessionHovercard.branchLabel")}: ${branch()}` : "",
    ]
      .filter(Boolean)
      .join(", ");
  const placement = createMemo(() =>
    props.row?.placementProviderId && props.row.placementProfileId
      ? {
          label: `${props.row.placementProviderId} · ${props.row.placementProfileId}`,
          title: t("sessionHovercard.runsOn", {
            providerId: props.row.placementProviderId,
            profileId: props.row.placementProfileId,
          }),
        }
      : undefined,
  );
  return (
    <div class="session-hovercard__context">
      <Show when={name()}>
        <ContextRow
          icon={<Icon name={branch() ? "gitBranch" : "folder"} />}
          value={
            <>
              {name()}
              <Show when={branch()}>
                {" "}
                <span class="session-hovercard__context-separator">/</span> {branch()}
              </Show>
            </>
          }
          label={locationLabel()}
          title={projectLocation() ? `${contextLabel()}: ${projectLocation()}` : undefined}
          end={
            <Show when={props.showChanges && props.branch}>
              <SessionGitDiff classPrefix="session-hovercard" item={props.branch ?? {}} />
            </Show>
          }
        />
      </Show>
      <Show when={placement()}>
        <ContextRow
          icon={<Icon name="server" />}
          value={placement()?.label ?? ""}
          label={placement()?.title ?? ""}
          title={placement()?.title}
        />
      </Show>
    </div>
  );
}

registerEnglishCatalog(registerGitHubEnglish);

const MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS = 4;
const MAX_VISIBLE_PULL_REQUESTS = 10;
type SessionHovercardAvatarAuth = { authTokens: readonly string[]; authReady: boolean };
export type SessionHovercardInput = {
  row?: SidebarSessionHovercardRow;
  selfUserId?: string;
  avatarAuth?: SessionHovercardAvatarAuth;
  personActivity?: PersonActivityRouting;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  progressCard?: ProgressCard | null;
  connected?: boolean;
};
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
        ref={createHovercardControlRef()}
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

function SessionAttribution(props: SessionHovercardInput) {
  const attribution = createMemo(() =>
    props.row ? sessionAttribution(props.row, props.selfUserId) : undefined,
  );
  const controls = useContext(HovercardControlsContext);
  const registerLink = (element: HTMLAnchorElement) => controls?.registerSource(() => [element]);
  const creatorInitials = createMemo(() => {
    const creator = attribution()?.creator;
    return creator ? sessionOwnerInitials(creator) : "";
  });
  const primaryActivity = () => {
    const current = attribution();
    return current?.primaryIdentity?.type === "profile"
      ? personActivityLink(current.primaryIdentity.id, props.personActivity, current.primaryLabel)
      : null;
  };
  const avatarPerson = () => {
    const current = attribution();
    const participant = current?.participants[0];
    return (
      current?.creator ??
      (participant ? { ...participant, id: participant.identity.id } : undefined)
    );
  };
  const avatarUser = createMemo(() => {
    const person = avatarPerson();
    return person
      ? {
          id: person.id ?? person.identity?.id ?? "",
          name: person.label,
          avatarUrl: person.avatarUrl,
          watchedSessions: [],
        }
      : undefined;
  });
  const remaining = createMemo(() => {
    const current = attribution();
    return current ? (current.creator ? current.participants : current.participants.slice(1)) : [];
  });
  const otherCount = () => attribution()?.otherCount ?? 0;
  const otherLabel = () =>
    otherCount() > 0
      ? t(
          otherCount() === 1
            ? "sessionHovercard.attributionOther"
            : "sessionHovercard.attributionOthers",
          { count: String(otherCount()) },
        )
      : "";
  const attributionLabel = () =>
    [
      attribution()?.primaryLabel ?? "",
      otherCount() > 0
        ? t("sessionHovercard.moreParticipantsLabel", {
            count: String(otherCount()),
          })
        : "",
    ]
      .filter(Boolean)
      .join(", ");
  return (
    <Show when={attribution()}>
      <div class="session-hovercard__attribution" aria-label={attributionLabel()}>
        <span class="session-hovercard__attribution-copy">
          <PersonName
            ref={createHovercardControlRef()}
            label={attribution()?.primaryLabel ?? ""}
            link={primaryActivity()}
            class="session-hovercard__attribution-name"
          />
          <Show when={otherCount() > 0}>
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
                  ref={createHovercardControlRef()}
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
                    count: String(otherCount()),
                  })}
                >
                  {otherLabel()}
                </button>
                <ParticipantMenu
                  participants={remaining()}
                  count={otherCount()}
                  routing={props.personActivity}
                />
              </openclaw-tooltip>
            </Show>
          </Show>
        </span>
        <span class="session-hovercard__attribution-avatars">
          <PersonAvatarLink link={primaryActivity()}>
            <Show
              when={Boolean(attribution()?.creator && props.row?.channelAvatarUrl)}
              fallback={
                <Show when={avatarPerson()}>
                  <ViewerAvatar
                    class="session-hovercard__creator-avatar"
                    user={avatarUser()}
                    markAsViewer={false}
                    identity={avatarPerson()?.identity}
                    variant="session"
                    aria-hidden="true"
                  />
                </Show>
              }
            >
              <ChannelAvatar
                class="session-hovercard__creator-avatar"
                routeUrl={props.row?.channelAvatarUrl}
                authTokens={props.avatarAuth?.authTokens ?? []}
                authReady={props.avatarAuth?.authReady ?? false}
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
            <ViewerFacepile
              registerLink={registerLink}
              staticParticipants={remaining()}
              totalCount={otherCount()}
              maxVisible={Math.min(remaining().length, MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS)}
              personActivity={props.personActivity}
            />
          </Show>
        </span>
      </div>
    </Show>
  );
}

function Header(props: SessionHovercardInput) {
  const channel = () => props.row?.channelPresentation;
  const details = createMemo(() => [
    ...new Set(
      [channel()?.conversation, channel()?.address].filter(
        (value) => value && value !== props.row?.label,
      ),
    ),
  ]);
  const age = (suffix = false) => {
    i18nRevision();
    return formatSessionAge(props.row?.createdAt, suffix);
  };
  return (
    <header class="session-hovercard__header">
      <Show when={channel()}>
        <span class="session-hovercard__channel">
          <span aria-hidden="true">
            <Icon name="link" />
          </span>
          {t("sessionHovercard.linkedChannel", { channel: channel()?.channelLabel ?? "" })}
        </span>
      </Show>
      <span class="session-hovercard__title">{props.row?.label}</span>
      <Show when={age()}>
        <span class="session-hovercard__created-age" title={age(true)}>
          {age()}
        </span>
      </Show>
      <Show when={channel()} fallback={<SessionAttribution {...props} />}>
        <span class="session-hovercard__conversation">
          <Show when={channel()?.kind} keyed>
            {(kind) => (
              <span>
                {channel()?.topicId
                  ? t("sessionHovercard.topicNumber", { id: channel()?.topicId ?? "" })
                  : t(`sessionHovercard.chatKinds.${kind}`)}
              </span>
            )}
          </Show>
          <For each={details()}>{(detail) => <span>{detail}</span>}</For>
          <Show when={channel()?.account} keyed>
            {(account) => <span>{t("sessionHovercard.viaAccount", { account })}</span>}
          </Show>
        </span>
      </Show>
    </header>
  );
}

function PullRequestRow(props: { request: SessionDisplayPullRequest }) {
  const state = () =>
    props.request.state
      ? t(`sessionHovercard.states.${props.request.state}`)
      : t("sessionHovercard.stateUnavailable");
  const checks = () =>
    props.request.checks ? t(`sessionHovercard.checks.${props.request.checks.state}`) : null;
  const details = () =>
    [
      state(),
      checks(),
      props.request.additions === undefined ? null : `+${props.request.additions.toLocaleString()}`,
      props.request.deletions === undefined ? null : `−${props.request.deletions.toLocaleString()}`,
      props.request.sourceSessionKey
        ? t("sessionHovercard.taskBranch", { branch: props.request.branch })
        : null,
    ].filter((detail): detail is string => Boolean(detail));
  const stateLabel = () => (checks() ? `${state()} · ${checks()}` : state());
  return (
    <a
      ref={createHovercardControlRef()}
      class="session-hovercard__pr-row"
      data-state={props.request.state}
      href={props.request.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${t("chat.pullRequests.linkLabel", { reference: formatGitHubItemReference(props.request), title: props.request.title })}, ${details().join(", ")}`}
    >
      <span
        class="session-hovercard__pr-state-icon"
        role="img"
        data-checks={props.request.checks?.state}
        aria-label={stateLabel()}
        title={stateLabel()}
      >
        <Icon
          name={
            props.request.state
              ? sessionPullRequestStateIcons[props.request.state]
              : "gitPullRequest"
          }
        />
      </span>
      <span class="session-hovercard__pr-title">{props.request.title}</span>
      <Show
        when={props.request.checks?.state === "failing"}
        fallback={
          <Show
            when={props.request.checks?.state === "pending"}
            fallback={<span class="session-hovercard__pr-number">#{props.request.number}</span>}
          >
            <span class="session-run-spinner" aria-hidden="true" />
          </Show>
        }
      >
        <span class="session-hovercard__pr-checks">
          {t("sessionHovercard.checks.failingCount", {
            count: String(Math.max(1, props.request.checks?.failed ?? 0)),
          })}
        </span>
      </Show>
    </a>
  );
}

function PullRequestDetails(props: { snapshot?: ControlUiSessionPullRequestSnapshot }) {
  const requests = createMemo(() => displaySessionPullRequests(props.snapshot));
  const visible = createMemo(() => requests().slice(0, MAX_VISIBLE_PULL_REQUESTS));
  const count = createMemo(
    () =>
      props.snapshot?.pullRequestCount ??
      Math.max(requests().length, props.snapshot?.taskPullRequestCount ?? 0),
  );
  const remaining = createMemo(() => Math.max(0, count() - visible().length));
  return (
    <Show when={requests().length > 0}>
      <div class="session-hovercard__pr-list">
        <div class="session-hovercard__section-title">
          {t("sessionHovercard.pullRequests")}
          <span class="session-hovercard__pr-count">{count()}</span>
        </div>
        <For each={visible()} keyed={(request) => request.url}>
          {(request) => <PullRequestRow request={request()} />}
        </For>
        <Show when={remaining() > 0}>
          <div class="session-hovercard__more">
            {t("sessionHovercard.morePullRequests", {
              count: String(remaining()),
            })}
          </div>
        </Show>
      </div>
    </Show>
  );
}

function HovercardExcerpt(props: { text: string }) {
  let element!: HTMLDivElement;
  createLayoutMeasurement(
    () => props.text,
    (text) => () => writeHovercardExcerpt(element, text!),
    { targets: () => [element], fonts: true, changeTiming: "sync" },
  );
  return (
    <div
      class="session-hovercard__excerpt"
      dir="auto"
      ref={(node) => {
        element = node;
      }}
    />
  );
}

export function SessionHovercard(props: SessionHovercardInput) {
  const controls = useContext(HovercardControlsContext);
  const headsUp = createMemo(() =>
    progressCardHeadsUp(
      props.progressCard,
      props.row?.status,
      props.row?.startedAt,
      props.connected !== false &&
        (props.row?.gatewayHasActiveRun ?? props.row?.hasActiveRun) === true,
      props.connected !== false && props.row?.hasActiveSubagentRun === true,
      props.row?.endedAt,
    ),
  );
  const hasPullRequestSection = () =>
    Boolean(
      props.pullRequests &&
      (props.pullRequests.pullRequests.length > 0 ||
        (props.pullRequests.taskPullRequests?.length ?? 0) > 0 ||
        props.pullRequests.status !== "ready"),
    );
  const hasContext = () =>
    Boolean(
      props.row?.workContext ||
      props.pullRequests?.branch ||
      (props.row?.placementProviderId && props.row?.placementProfileId),
    );
  const commentary = () => props.progressCard?.markdown?.trim() || undefined;
  const preview = () =>
    props.progressCard ? undefined : props.row?.lastMessagePreview?.trim() || undefined;
  return (
    <Show
      when={Boolean(props.row || hasContext() || hasPullRequestSection() || props.progressCard)}
    >
      <div class="session-hovercard">
        <Show when={props.row || hasContext()}>
          <div class="session-hovercard__top">
            <Show when={props.row}>
              <section class="session-hovercard__section session-hovercard__section--header">
                <Header {...props} />
              </section>
            </Show>
            <Show when={hasContext()}>
              <section class="session-hovercard__section session-hovercard__section--metadata">
                <SessionHovercardContext
                  row={props.row}
                  branch={props.pullRequests?.branch}
                  showChanges={!props.pullRequests?.pullRequests.length}
                />
              </section>
            </Show>
          </div>
        </Show>
        <Show when={props.row?.attention?.kind === "error"}>
          <section class="session-hovercard__section session-hovercard__error">
            <span class="session-hovercard__error-icon" aria-hidden="true">
              <Icon name="alertTriangle" />
            </span>
            <span>
              {props.row?.attention ? sessionAttentionSubtitle(props.row.attention, t) : ""}
            </span>
          </section>
        </Show>
        <Show when={commentary() || headsUp()}>
          <section
            class="session-hovercard__section session-hovercard__task session-hovercard__notepad"
            aria-label={t("sessionHovercard.agentNotepad")}
          >
            <div class="session-hovercard__section-title session-hovercard__notepad-title">
              {t("sessionHovercard.agentNotepad")}
            </div>
            <Show when={commentary()}>
              <div class="session-hovercard__commentary">
                <ProgressCardMarkdown
                  markdown={props.progressCard?.markdown}
                  omitProgress
                  previewLines={3}
                  registerControls={controls?.registerSource}
                />
              </div>
            </Show>
            <ProgressHeadsUp headsUp={headsUp()} />
          </section>
        </Show>
        <Show when={preview()}>
          <section class="session-hovercard__section session-hovercard__task">
            <HovercardExcerpt text={preview()!} />
          </section>
        </Show>
        <Show when={hasPullRequestSection()}>
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
            <SessionAttribution {...props} />
          </section>
        </Show>
      </div>
    </Show>
  );
}
