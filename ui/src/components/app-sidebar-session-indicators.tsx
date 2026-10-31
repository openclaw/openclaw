import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { resolveControlUiAvatarAuth } from "../app/control-ui-auth.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { formatDurationCompact } from "../lib/format-duration.ts";
import { presenceMatchesProfile, projectPresencePayload } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { formatSessionSnoozeWakeTime, isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import type { CatalogBackingSessionDisplay } from "./app-sidebar-session-catalogs.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { sidebarSessionMetaId, sidebarSessionStateId } from "./app-sidebar-session-types.ts";
import { ElapsedTime } from "./elapsed-time.tsx";
import { describeSessionState } from "./session-leading-indicator.ts";
import { sidebarSessionBadgeFacts } from "./session-row-badge-presentation.ts";
import { Icon, sessionIcon } from "./solid/icon.tsx";
import {
  renderSessionLeadingState,
  sessionRunVisibility,
  SessionRowBadges,
} from "./solid/session-presentation.tsx";
import { EMPTY_VIEWER_IDENTITIES } from "./solid/viewer-facepile.tsx";
import "./tooltip.ts";
/** Compose independently owned session state and context indicators. */
export function renderSidebarSessionIndicators(
  host: () => SessionListHost,
  readSession: () => SidebarRecentSession,
  readDisplay?: () => CatalogBackingSessionDisplay | undefined,
  readIcon?: () => JSX.Element,
) {
  const team = createMemo(() => host().sidebarAgentsMode === "roster");
  const childrenExpanded = createMemo(() => host().isSessionChildrenExpanded(readSession()));
  const badges = createMemo(() =>
    sidebarSessionBadgeFacts(
      host().sessionPullRequests,
      readSession(),
      readSession().pullRequest ?? readDisplay?.()?.pullRequest,
    ),
  );
  const pullRequest = () => badges().pullRequest;
  const ownerAttribution = createMemo(() => {
    const readSessionValue = readSession();
    return host().sessionsStatusFilter === "archived"
      ? "archived"
      : readSessionValue.owner?.assignedAt !== undefined
        ? "owned"
        : "created";
  });
  const ownerActor = createMemo(() => {
    const readSessionValue = readSession();
    return host().sessionOwnershipVisibility.avatars
      ? host().sessionsStatusFilter === "archived"
        ? readSessionValue.archivedBy
        : readSessionValue.owner?.actor
      : undefined;
  });
  const ownerViewing = createMemo(() => {
    const ownerActorValue = ownerActor();
    const readSessionValue = readSession();
    return ownerActorValue?.identity?.type === "profile"
      ? projectPresencePayload(host().sessionData.presencePayload).users.some(
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
      host().sessionsGrouping === "person" &&
      !readSession().pinned &&
      ownerAttribution() !== "archived",
  );
  // A self filter already identifies solo ownership. Keep shared rows and
  // archive attribution visible; the participant count includes unshown faces.
  const selfUser = createMemo(() => {
    const gateway = host().sessionDataContext?.gateway;
    return gateway ? gatewayPresentationScope(gateway).displayUser : null;
  });
  const selfProfileId = createMemo(() => selfUser()?.identity?.id ?? selfUser()?.id);
  const ownerRepeatedByFilter = createMemo(() => {
    const actor = ownerActor();
    return (
      ownerAttribution() !== "archived" &&
      actor?.identity?.type === "profile" &&
      actor.identity.id === selfProfileId() &&
      (host().sessionInvolvingMeFilterActive || host().sessionOwnerFilterId === actor.id) &&
      (readSession().participantCount ?? readSession().participants?.length ?? 0) === 0
    );
  });
  const leadingOwner = createMemo(() =>
    ownerRepeatedByFilter() || (!team() && ownerRepeatedBySection() && ownerViewing() !== true)
      ? undefined
      : ownerActor(),
  );
  const gateway = createMemo(() => host().sessionDataContext?.gateway);
  const channelAvatarAuth = createMemo(() =>
    resolveControlUiAvatarAuth({
      hello: gateway()?.snapshot.hello,
      settings: gateway()?.connection,
      password: gateway()?.connection.password,
    }),
  );
  const { running, leadingIndicator, renderedIdentities } = renderSessionLeadingState({
    get session() {
      return readSession();
    },
    get ownerActor() {
      return leadingOwner();
    },
    get attribution() {
      return ownerAttribution();
    },
    get ownerViewing() {
      return ownerViewing();
    },
    get avatarAuth() {
      return channelAvatarAuth();
    },
    get icon() {
      return readIcon?.();
    },
    runVisibility: sessionRunVisibility,
  });
  const stateDescription = createMemo(() => describeSessionState(readSession()));
  const snoozed = createMemo(
    () =>
      !readSession().isChild &&
      (host().sessionsStatusFilter === "snoozed" || host().sessionsStatusFilter === "all") &&
      isSessionSnoozed(readSession(), Date.now()),
  );
  const hasTrail = createMemo(
    () =>
      snoozed() ||
      // A finished child's duration is history; the row keeps only live elapsed time.
      (readSession().isChild &&
        readSession().hasActiveRun &&
        (readSession().runtimeMs != null || readSession().startedAt != null)),
  );
  const metaId = createMemo(() =>
    hasTrail() ? sidebarSessionMetaId(readSession().key) : undefined,
  );
  const stateId = createMemo(() =>
    stateDescription() ? sidebarSessionStateId(readSession().key) : undefined,
  );
  const persistentIndicator = (
    <span class="sidebar-session-indicator">
      {leadingIndicator}
      {readSession().visibility === "draft" ? (
        <span
          class="session-row-draft-indicator"
          role="img"
          aria-label={t("chat.sessionSharing.draft")}
          title={t("chat.sessionSharing.draft")}
        >
          {sessionIcon("circleDashed", 14, 2)}
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
      <span
        class={["session-row-trail", { "session-row-trail--snooze": snoozed() }]}
        id={metaId()}
        title={
          snoozed()
            ? t("sessionsView.snoozeWakes", {
                time: formatSessionSnoozeWakeTime(readSession().snoozedUntil!),
              })
            : undefined
        }
      >
        {snoozed() ? (
          <>
            {sessionIcon("moon", 13, 2)}
            {formatSessionSnoozeWakeTime(readSession().snoozedUntil!, new Date(), true)}
          </>
        ) : currentSession.runtimeMs != null ? (
          currentSession.hasActiveRun ? (
            <ElapsedTime startMs={currentSession.runtimeSampledAt! - currentSession.runtimeMs} />
          ) : (
            (formatDurationCompact(currentSession.runtimeMs) ?? "0ms")
          )
        ) : (
          <ElapsedTime startMs={readSession().startedAt!} endMs={readSession().endedAt ?? null} />
        )}
      </span>
    ) : undefined;
  });
  return {
    running,
    stateId,
    metaId,
    pullRequest,
    persistentIndicator,
    originIndicators,
    childrenExpanded,
    content: (
      <>
        {" "}
        <span class="sidebar-recent-session__details-endcap">
          <openclaw-viewer-facepile
            prop:presencePayload={host().sessionData.presencePayload}
            prop:selfUser={selfUser()}
            prop:selfInstanceId={host().sessionData.presenceInstanceId}
            prop:sessionKey={readSession().key}
            prop:excludeIdentities={renderedIdentities() ?? EMPTY_VIEWER_IDENTITIES}
            prop:maxVisible={3}
            prop:overflowInSlots={true}
            variant="session"
          />
          <SessionRowBadges
            {...readSession()}
            hasComposerDraft={readSession().hasComposerDraft === true}
            pullRequest={pullRequest()}
            pullRequestCount={badges().pullRequestCount}
            hasApproval={badges().hasApproval}
          />
          {stateDescription() ? (
            <span class="sr-only" id={stateId()} aria-hidden="true">
              {stateDescription()}
            </span>
          ) : undefined}
          {trail()}
        </span>
      </>
    ),
  };
}
