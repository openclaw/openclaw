import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createMemo, For, Show, useContext } from "solid-js";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../src/gateway/control-ui-contract.js";
import { registerGitHubEnglish } from "../i18n/locales/en-github.ts";
import { i18nRevision, registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import { sessionOwnerInitials } from "../lib/session-owner.ts";
import {
  orderSessionPullRequests,
  sessionPullRequestStateIcons,
} from "../lib/session-pull-request-presentation.ts";
import { formatGitHubItemReference } from "./github-link-target.ts";
import { PersonAvatarLink, PersonName } from "./person-activity-link-solid.tsx";
import { personActivityLink, type PersonActivityRouting } from "./person-activity-link.ts";
import { createHovercardControlRef, HovercardControlsContext } from "./portaled-hovercard-focus.ts";
import { sessionAttentionSubtitle } from "./session-attention-presentation.ts";
import { SessionColorDot } from "./session-color.tsx";
import { SessionGitDiff } from "./session-git-diff.tsx";
import {
  SessionHovercardContext,
  type SessionHovercardContextInput,
} from "./session-hovercard-context-solid.tsx";
import { participantLabel, formatSessionAge, sessionAttribution } from "./session-hovercard.ts";
import { ProgressCardMarkdown } from "./session-progress-card-view.tsx";
import { progressCardHeadsUp } from "./session-progress-card.ts";
import { ChannelAvatar } from "./solid/channel-avatar.tsx";
import { Icon } from "./solid/icon.tsx";
import { ViewerAvatar, ViewerFacepile } from "./solid/viewer-facepile.tsx";
import "./session-hovercard.css";
import "./tooltip.ts";

registerEnglishCatalog(registerGitHubEnglish);

type SessionDisplayPullRequest = Omit<ControlUiSessionPullRequest, "state"> & {
  state?: ControlUiSessionPullRequest["state"];
  sourceSessionKey?: string;
  sourceAgentId?: string;
};

/** Presentation only: task results never become evidence that the current branch was published. */
function displaySessionPullRequests(
  snapshot: ControlUiSessionPullRequestSnapshot | undefined,
): SessionDisplayPullRequest[] {
  const requests = new Map<string, SessionDisplayPullRequest>();
  for (const task of snapshot?.taskPullRequests ?? []) {
    requests.set(task.url, {
      owner: task.owner,
      repo: task.repo,
      number: task.number,
      branch: task.branch,
      url: task.url,
      title: task.title ?? `${task.owner}/${task.repo}#${task.number}`,
      ...task.pullRequest,
      sourceSessionKey: task.sourceSessionKey,
      sourceAgentId: task.sourceAgentId,
    });
  }
  for (const request of snapshot?.pullRequests ?? []) {
    requests.set(request.url, { ...requests.get(request.url), ...request });
  }
  return orderSessionPullRequests([...requests.values()]);
}

const MAX_VISIBLE_ATTRIBUTION_PARTICIPANTS = 4;
type SessionHovercardAvatarAuth = { authTokens: readonly string[]; authReady: boolean };
export type SessionHovercardInput = SessionHovercardContextInput & {
  selfUserId?: string;
  avatarAuth?: SessionHovercardAvatarAuth;
  personActivity?: PersonActivityRouting;
  pullRequests?: ControlUiSessionPullRequestSnapshot;
  progressCard?: ProgressCard | null;
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
      <span class="session-hovercard__heading">
        <Show when={channel()}>
          <span class="session-hovercard__channel">
            <span aria-hidden="true">
              <Icon name="link" />
            </span>
            {t("sessionHovercard.linkedChannel", { channel: channel()?.channelLabel ?? "" })}
          </span>
        </Show>
        <span class="session-hovercard__title">
          <SessionColorDot value={props.row?.color} />
          {props.row?.label}
        </span>
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
      </span>
      <Show when={age()}>
        <span class="session-hovercard__created-age" title={age(true)}>
          {age()}
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
      <span class="session-hovercard__pr-main">
        <span class="session-hovercard__pr-title">{props.request.title}</span>
        <span class="session-hovercard__pr-meta">
          <span class="session-hovercard__pr-number">
            {formatGitHubItemReference(props.request)}
          </span>
          <span class="session-hovercard__pr-state">{state()}</span>
          <SessionGitDiff classPrefix="session-hovercard" item={props.request} />
        </span>
        <Show when={checks()}>
          <span class="session-hovercard__pr-checks" data-checks={props.request.checks?.state}>
            {checks()}
          </span>
        </Show>
        <Show when={props.request.sourceSessionKey}>
          <span class="session-hovercard__pr-source">
            {t("sessionHovercard.taskBranch", { branch: props.request.branch })}
          </span>
        </Show>
      </span>
    </a>
  );
}

function PullRequestDetails(props: { snapshot?: ControlUiSessionPullRequestSnapshot }) {
  const branch = () => props.snapshot?.branch;
  const requests = createMemo(() => displaySessionPullRequests(props.snapshot));
  const count = createMemo(
    () =>
      props.snapshot?.pullRequestCount ??
      Math.max(requests().length, props.snapshot?.taskPullRequestCount ?? 0),
  );
  const remaining = createMemo(() => Math.max(0, count() - requests().length));
  const branchLabel = () =>
    t("chat.pullRequests.createPrLabel", { branch: branch()?.branch ?? "" });
  return (
    <>
      <Show when={branch() && !props.snapshot?.pullRequests.length}>
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
              ref={createHovercardControlRef()}
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
          <SessionGitDiff classPrefix="session-hovercard" item={branch() ?? {}} />
        </div>
      </Show>
      <Show when={requests().length > 0}>
        <div class="session-hovercard__pr-list">
          <div class="session-hovercard__pr-heading">
            <span>{t("sessionHovercard.pullRequests")}</span>
            <span class="session-hovercard__pr-count">{count()}</span>
          </div>
          <For each={requests()} keyed={(request) => request.url}>
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
    </>
  );
}

export function SessionHovercard(props: SessionHovercardInput) {
  const controls = useContext(HovercardControlsContext);
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
        (props.pullRequests.taskPullRequests?.length ?? 0) > 0 ||
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
          <section class="session-hovercard__section session-hovercard__section--header">
            <Header {...props} />
          </section>
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
            <span>
              {props.row?.attention ? sessionAttentionSubtitle(props.row.attention, t) : ""}
            </span>
          </section>
        </Show>
        <Show when={props.progressCard?.markdown?.trim()}>
          <section
            class="session-hovercard__section session-hovercard__notepad"
            aria-label={t("sessionHovercard.agentNotepad")}
          >
            <div class="session-hovercard__notepad-title">{t("sessionHovercard.agentNotepad")}</div>
            <ProgressCardMarkdown
              markdown={props.progressCard?.markdown}
              promoteProgress
              registerControls={controls?.registerSource}
            />
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
