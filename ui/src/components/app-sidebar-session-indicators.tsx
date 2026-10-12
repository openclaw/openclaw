import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { resolveControlUiAvatarAuth } from "../app/control-ui-auth.ts";
import { formatDurationCompact } from "../lib/format-duration.ts";
import { presenceMatchesProfile, projectPresencePayload } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { formatSessionSnoozeWakeTime, isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import type { CatalogBackingSessionDisplay } from "./app-sidebar-session-catalogs.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sidebarSessionMetaId, sidebarSessionStateId } from "./app-sidebar-session-types.ts";
import { describeSessionState } from "./session-leading-indicator.ts";
import { Icon } from "./solid/icon.tsx";
import {
  renderSessionLeadingState,
  sessionRunVisibility,
  renderTeamSessionSlots,
  SessionRowBadges,
} from "./solid/session-presentation.tsx";
import { EMPTY_VIEWER_IDENTITIES } from "./viewer-facepile.ts";
import "./elapsed-time.tsx";
import "./tooltip.ts";
/** Compose independently owned session state and context indicators. */
export function renderSidebarSessionIndicators(
  host: SessionListHost,
  readSession: () => SidebarRecentSession,
  display?: CatalogBackingSessionDisplay,
  readIcon?: () => JSX.Element,
  headerSummary?: Parameters<typeof renderTeamSessionSlots>,
) {
  const team = createMemo(() => host.sidebarAgentsMode === "roster");
  const ownAttention = createMemo(() => readSession().ownAttention ?? readSession().attention);
  const hasApproval = createMemo(() => {
    const attention = ownAttention();
    return attention.kind === "question"
      ? attention.requests.some((request) => request.kind === "approval")
      : !team() && attention.kind === "approval";
  });
  const childrenExpanded = createMemo(() => host.isSessionChildrenExpanded(readSession()));
  const initialPullRequest = createMemo(() => readSession().pullRequest ?? display?.pullRequest);
  const pullRequest = createMemo(() => {
    const readSessionValue = readSession();
    const initialPullRequestValue = initialPullRequest();
    return readSessionValue.worktreeId
      ? host.sessionPullRequests.summary(
          readSessionValue.key,
          readSessionValue.worktreeId,
          initialPullRequestValue,
        )
      : initialPullRequestValue;
  });
  const ownerAttribution = createMemo(() => {
    const readSessionValue = readSession();
    return host.sessionsStatusFilter === "archived"
      ? "archived"
      : readSessionValue.owner?.assignedAt !== undefined
        ? "owned"
        : "created";
  });
  const ownerActor = createMemo(() => {
    const readSessionValue = readSession();
    return host.sessionOwnershipVisibility.avatars
      ? host.sessionsStatusFilter === "archived"
        ? readSessionValue.archivedBy
        : readSessionValue.owner?.actor
      : undefined;
  });
  const ownerViewing = createMemo(() => {
    const ownerActorValue = ownerActor();
    const readSessionValue = readSession();
    return ownerActorValue?.identity?.type === "profile"
      ? projectPresencePayload(host.sessionData.presencePayload).users.some(
          (user) =>
            presenceMatchesProfile(user, ownerActorValue.identity) &&
            user.watchedSessions.includes(readSessionValue.key),
        )
      : undefined;
  });
  // Person sections already own durable attribution. Restore the row avatar
  // only for live presence; pinned and archive-attribution rows have no matching header.
  const ownerRepeatedBySection = createMemo(
    () =>
      host.sessionsGrouping === "person" &&
      !readSession().pinned &&
      ownerAttribution() !== "archived",
  );
  // A self filter already identifies solo ownership. Keep shared rows and
  // archive attribution visible; the participant count includes unshown faces.
  const selfUser = createMemo(() => host.sessionDataContext?.gateway.snapshot.selfUser);
  const selfProfileId = createMemo(() => selfUser()?.identity?.id ?? selfUser()?.id);
  const ownerRepeatedByFilter = createMemo(() => {
    const actor = ownerActor();
    return (
      ownerAttribution() !== "archived" &&
      actor?.identity?.type === "profile" &&
      actor.identity.id === selfProfileId() &&
      (host.sessionInvolvingMeFilterActive || host.sessionOwnerFilterId === actor.id) &&
      (readSession().participantCount ?? readSession().participants?.length ?? 0) === 0
    );
  });
  const leadingOwner = createMemo(() => {
    const ownerRepeatedByFilterValue = ownerRepeatedByFilter();
    const teamValue = team();
    const ownerRepeatedBySectionValue = ownerRepeatedBySection();
    const ownerViewingValue = ownerViewing();
    const ownerActorValue = ownerActor();
    return ownerRepeatedByFilterValue ||
      (!teamValue && ownerRepeatedBySectionValue && ownerViewingValue !== true)
      ? undefined
      : ownerActorValue;
  });
  const gateway = createMemo(() => host.sessionDataContext?.gateway);
  const channelAvatarAuth = createMemo(() =>
    resolveControlUiAvatarAuth({
      hello: gateway()?.snapshot.hello,
      settings: gateway()?.connection,
      password: gateway()?.connection.password,
    }),
  );
  const runVisibility = createMemo(() => sessionRunVisibility());
  const teamSummary = createMemo<Parameters<typeof renderTeamSessionSlots>>(
    () =>
      headerSummary ?? [
        [readSession()],
        !childrenExpanded(),
        readSession().childSessionKeys.length,
        0,
        runVisibility(),
      ],
  );
  const leadingState = createMemo(() =>
    renderSessionLeadingState(
      readSession(),
      leadingOwner(),
      ownerAttribution(),
      ownerViewing(),
      channelAvatarAuth(),
      team(),
      readIcon?.(),
      runVisibility(),
    ),
  );
  const running = createMemo(() => leadingState().running),
    leadingIndicator = createMemo(() => leadingState().leadingIndicator),
    renderedIdentities = createMemo(() => leadingState().renderedIdentities);
  const stateDescription = createMemo(() => describeSessionState(readSession()));
  const snoozed = createMemo(
    () =>
      !readSession().isChild &&
      (host.sessionsStatusFilter === "snoozed" || host.sessionsStatusFilter === "all") &&
      isSessionSnoozed(readSession(), Date.now()),
  );
  const hasTrail = createMemo(
    () =>
      snoozed() ||
      (readSession().isChild &&
        (readSession().runtimeMs != null || readSession().startedAt != null)),
  );
  const metaId = createMemo(() => {
    const hasTrailValue = hasTrail();
    const readSessionValue = readSession();
    return hasTrailValue ? sidebarSessionMetaId(readSessionValue.key) : undefined;
  });
  const stateId = createMemo(() => {
    const teamValue = team();
    const stateDescriptionValue = stateDescription();
    const readSessionValue = readSession();
    return !teamValue && stateDescriptionValue
      ? sidebarSessionStateId(readSessionValue.key)
      : undefined;
  });
  const persistentIndicator = (
    <span class="sidebar-session-indicator">
      {leadingIndicator()}
      {readSession().visibility === "draft" ? (
        <span class="session-row-draft-indicator" title={t("chat.sessionSharing.draft")}>
          👻
        </span>
      ) : undefined}
    </span>
  );
  const originIndicators = (
    <>
      {readSession().archived ? (
        <span
          class="sidebar-session__archive-glyph"
          role="img"
          aria-label={t("sessionsView.archived")}
          title={t("sessionsView.archived")}
        >
          <Icon name="archive" />
        </span>
      ) : undefined}
      {readSession().forkSource ? (
        <span
          class="sidebar-session-fork-indicator"
          aria-hidden={team() || readSession().isChild ? undefined : "true"}
          role="img"
          aria-label={t("sessionsView.forkedSession")}
        >
          <Icon name="gitFork" />
        </span>
      ) : undefined}
    </>
  );
  const trail = createMemo(() => {
    const currentSession = readSession();
    return hasTrail() ? (
      <span class="session-row-trail" id={metaId()}>
        {snoozed() ? (
          t("sessionsView.snoozeWakes", {
            time: formatSessionSnoozeWakeTime(readSession().snoozedUntil!),
          })
        ) : currentSession.runtimeMs != null ? (
          currentSession.hasActiveRun ? (
            <openclaw-elapsed-time
              prop:startMs={currentSession.runtimeSampledAt! - currentSession.runtimeMs}
            />
          ) : (
            (formatDurationCompact(currentSession.runtimeMs) ?? "0ms")
          )
        ) : (
          <openclaw-elapsed-time
            prop:startMs={readSession().startedAt!}
            prop:endMs={readSession().endedAt ?? null}
          />
        )}
      </span>
    ) : undefined;
  });
  return {
    get running() {
      return running();
    },
    get stateId() {
      return stateId();
    },
    get metaId() {
      return metaId();
    },
    get pullRequest() {
      return pullRequest();
    },
    persistentIndicator,
    originIndicators,
    get childrenExpanded() {
      return childrenExpanded();
    },
    content: (
      <>
        {" "}
        <span class="sidebar-recent-session__details-endcap">
          {headerSummary &&
          (leadingIndicator() !== undefined || readSession().visibility === "draft")
            ? persistentIndicator
            : undefined}
          <openclaw-viewer-facepile
            prop:presencePayload={host.sessionData.presencePayload}
            prop:selfUser={host.sessionDataContext?.gateway.snapshot.selfUser}
            prop:selfInstanceId={host.sessionData.presenceInstanceId}
            prop:sessionKey={readSession().key}
            prop:excludeIdentities={renderedIdentities() ?? EMPTY_VIEWER_IDENTITIES}
            prop:maxVisible={3}
            variant="session"
          />
          {team() ? originIndicators : undefined}
          {team() &&
          (readSession().workSession || readSession().acpSession) &&
          !readSession().workspaceKind &&
          !pullRequest() ? (
            <span
              class="session-row-badge"
              role="img"
              aria-label={t("chat.sidebar.coding")}
              title={readSession().subtitle ?? t("chat.sidebar.coding")}
            >
              <Icon name="terminal" />
            </span>
          ) : undefined}
          {team() && readSession().hasAutomation ? (
            <span
              class="session-row-badge"
              role="img"
              aria-label={t("tabs.cron")}
              title={t("tabs.cron")}
            >
              <Icon name="clock" />
            </span>
          ) : undefined}
          {
            <SessionRowBadges
              isChild={readSession().isChild}
              incognito={readSession().incognito}
              placementState={readSession().placementState}
              placementProviderId={readSession().placementProviderId}
              placementProfileId={readSession().placementProfileId}
              placementMachine={readSession().placementMachine}
              diskSpaceStatus={readSession().diskSpaceStatus}
              workspaceConflictCount={readSession().workspaceConflictCount}
              outboxAttentionCount={readSession().outboxAttentionCount}
              hasComposerDraft={readSession().hasComposerDraft === true}
              pullRequest={pullRequest()}
              hasApproval={hasApproval()}
            />
          }
          {team() ? trail() : undefined}{" "}
          {team() ? renderTeamSessionSlots(...teamSummary()) : undefined}
          {!team() && stateDescription() ? (
            <span class="sr-only" id={stateId()} aria-hidden="true">
              {stateDescription()}
            </span>
          ) : undefined}
          {team() ? undefined : trail()}
        </span>
      </>
    ),
  };
}
