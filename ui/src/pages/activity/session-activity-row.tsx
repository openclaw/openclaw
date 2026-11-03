import { createMemo as createActivityMemo } from "@solidjs/signals";
import { dynamic } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import { sessionActivityTimestamp } from "../../../../src/shared/session-activity-timestamp.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { AgentRowChip } from "../../components/agent-row-chip.tsx";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import "../../components/solid/viewer-facepile.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { presenceViewerLabel } from "../../lib/presence-users.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, getLocale, t } from "../../lib/reactive/i18n.ts";
import { createMediaQuery } from "../../lib/reactive/platform.ts";
import {
  sharedAgentIdentityProjection,
  sharedAgentsProjection,
} from "../../lib/reactive/shared-application-projections.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  isSessionKeyAddressable,
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  isUiGlobalScopeConfigured,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
  scopedSessionArtifactKey,
} from "../../lib/sessions/session-key.ts";
import { activityRunInspectorHref } from "./run-inspector-model.ts";
import { ActivitySessionAccessories } from "./session-activity-accessories.tsx";
import { ActivitySessionMedia } from "./session-activity-media.tsx";
import { isUnresolvedPerson, UnknownPersonAvatar } from "./session-activity-people.tsx";
import { ACTIVITY_PHONE_QUERY, sessionActivityOwner } from "./session-activity.ts";

registerEnglishCatalog(registerActivityEnglish);

export function SessionLinkView(props: {
  row: GatewaySessionRow;
  onSummaryRetry?: (row: GatewaySessionRow) => void;
  presentationRevision?: number;
}) {
  const context = useApplication();
  const phone = createMediaQuery(ACTIVITY_PHONE_QUERY);
  const agentId = createMemo(
    () =>
      parseAgentSessionKey(props.row.key)?.agentId ??
      props.row.agentId ??
      resolveSessionNavigationAgentId(context),
  );
  const sessionHost = createMemo(() => ({
    agentsList: context.agents.state.agentsList,
    hello: context.gateway.snapshot.hello,
  }));
  const face = () => resolveSessionPreferredFace(props.row);
  const addressable = createMemo(() =>
    isSessionKeyAddressable(props.row.key, isUiGlobalScopeConfigured(sessionHost())),
  );
  const target = createMemo(() =>
    addressable()
      ? sessionNavigationTarget({
          face: face(),
          sessionKey: props.row.key,
          fallbackAgentId:
            props.row.key === "global" ? agentId() : resolveSessionNavigationAgentId(context),
          basePath: context.basePath,
          row: props.row,
          mainKey: resolveUiConfiguredMainKey(sessionHost()),
        })
      : null,
  );
  const SessionLink = dynamic(() => (target() ? "a" : "div"));
  const agents = sharedAgentsProjection(context.agents);
  const agentIdentity = sharedAgentIdentityProjection(context.agentIdentity);
  const owner = createMemo(() =>
    sessionActivityOwner(
      props.row,
      agents.read().agentsList,
      agentIdentity.read().get(props.row.agentId),
    ),
  );
  const ownerName = () => {
    getLocale();
    return presenceViewerLabel(owner());
  };
  const activityAt = () => sessionActivityTimestamp(props.row);
  const relativeTime = createMemo(() => {
    void props.presentationRevision;
    getLocale();
    return formatRelativeTimestamp(activityAt(), { fallback: "" });
  });
  const activeObserverRunId = createMemo(() => {
    const runId = props.row.observerDigest?.runId;
    return props.row.hasActiveRun === true && runId && props.row.activeRunIds?.includes(runId)
      ? runId
      : undefined;
  });
  const headline = () => (activeObserverRunId() ? props.row.observerDigest?.headline.trim() : "");
  const scope = () =>
    props.row.channel ? t("activityFeed.channelLabel", { value: props.row.channel }) : null;
  const showAgent = () => props.row.kind !== "global" || Boolean(props.row.agentId);
  const source = () => (props.row.createdVia === "cron" ? t("activityFeed.automation") : null);
  const summary = () => props.row.activitySummary;
  const state = () =>
    summary()?.state === "current" && !summary()?.text
      ? "missing"
      : (summary()?.state ?? "missing");
  const updating = () => state() === "updating";
  const feedback = () =>
    state() === "stale"
      ? t(summary()?.text ? "activityFeed.recapStale" : "activityFeed.recapMissing")
      : state() === "unavailable"
        ? t(summary()?.text ? "activityFeed.recapRefreshFailed" : "activityFeed.recapUnavailable")
        : state() === "missing"
          ? t("activityFeed.recapMissing")
          : "";
  const title = createActivityMemo(() => {
    const updatedAt = summary()?.updatedAt;
    return updatedAt
      ? t("activityFeed.recapUpdated", {
          time: formatRelativeTimestamp(updatedAt, { fallback: "" }),
        })
      : undefined;
  });
  const Headline = () => (
    <span
      class="activity-feed__session-headline"
      data-health={props.row.observerDigest?.health ?? undefined}
    >
      {headline()}
    </span>
  );
  const AgentScope = () =>
    showAgent() ? (
      <span class="activity-feed__session-scope">
        <AgentRowChip agentId={agentId()} />
      </span>
    ) : undefined;
  const ChannelScope = () =>
    scope() ? <span class="activity-feed__session-scope">{scope()}</span> : undefined;
  const InspectRun = () => (
    <Show when={activeObserverRunId()}>
      {(runId) => (
        <a
          class="activity-feed__inspect-run"
          href={activityRunInspectorHref(runId(), context.basePath)}
        >
          {t("activityFeed.inspectRun")}
        </a>
      )}
    </Show>
  );
  return (
    <div
      class={[
        "activity-feed__session-row",
        { "activity-feed__session-row--link": Boolean(target()) },
      ]}
    >
      <SessionLink
        class="activity-feed__session"
        data-activity-session={props.row.key}
        href={target()?.href ?? undefined}
        onClick={(event: MouseEvent) => {
          const destination = target();
          if (destination && shouldHandleNavigationClick(event)) {
            event.preventDefault();
            context.navigate(face(), destination.options);
          }
        }}
      >
        <span class="activity-feed__session-avatar">
          {props.row.hasActiveRun === true ? (
            <span
              class="activity-feed__presence-dot activity-feed__run-dot"
              role="img"
              aria-label={t("sessionsView.statusLive")}
            />
          ) : undefined}
          {phone() && isUnresolvedPerson(owner()) && !owner().avatarUrl ? (
            <UnknownPersonAvatar />
          ) : (
            <openclaw-viewer-avatar
              prop:identity={props.row.owner?.actor.identity ?? props.row.createdActor?.identity}
              prop:user={owner()}
              prop:markAsViewer={false}
              variant="footer"
            />
          )}
        </span>
        <span class="activity-feed__session-main">
          <span class="activity-feed__session-title">
            {resolveSessionDisplayName(props.row.key, props.row)}
          </span>
          {phone() ? (
            <>
              {headline() ? <Headline /> : undefined}
              <span class="activity-feed__session-meta activity-feed__session-meta--line">
                {/* A raw actor id stays reachable through the person filter. */}
                {isUnresolvedPerson(owner()) ? undefined : (
                  <span class="activity-feed__session-owner">{ownerName()}</span>
                )}
                {source() ? (
                  <span class="activity-feed__session-source" data-activity-created-via="cron">
                    {source()}
                  </span>
                ) : undefined}
                <AgentScope />
                <ChannelScope />
                {activityAt() > 0 ? (
                  <span class="activity-feed__session-time">{relativeTime()}</span>
                ) : undefined}
              </span>
            </>
          ) : (
            <span class="activity-feed__session-meta">
              {headline() ? <Headline /> : <span>{ownerName()}</span>}
              {source() ? (
                <span class="activity-feed__session-source" data-activity-created-via="cron">
                  · {source()}
                  {scope() || showAgent() ? " ·" : ""}
                </span>
              ) : undefined}
              <AgentScope />
              <ChannelScope />
            </span>
          )}
        </span>
        {phone() ? undefined : (
          <span class="activity-feed__session-time">
            {headline() ? (
              <span class="activity-feed__session-owner">{ownerName()}</span>
            ) : undefined}
            {activityAt() > 0 ? <span>{relativeTime()}</span> : undefined}
          </span>
        )}
      </SessionLink>
      <div
        class="activity-feed__recap"
        data-activity-recap={props.row.key}
        data-state={state()}
        role="group"
        aria-busy={updating() ? "true" : "false"}
        aria-label={t("activityFeed.recap")}
        title={title()}
      >
        {summary()?.text ? (
          <p class={["activity-feed__recap-text", { "text-shimmer": updating() }]}>
            {summary()?.text}
          </p>
        ) : updating() ? (
          <div class="activity-feed__recap-skeleton" aria-hidden="true">
            <div class="skeleton skeleton-line skeleton-line--long" />
            <div class="skeleton skeleton-line skeleton-line--medium" />
          </div>
        ) : undefined}
        {updating() ? (
          <span class="sr-only" role="status">
            {t("activityFeed.recapUpdating")}
          </span>
        ) : undefined}
        {feedback() ? (
          <div class="activity-feed__note">
            <span>{feedback()}</span>
            {props.onSummaryRetry &&
            summary()?.canEnsure === true &&
            (state() === "unavailable" || state() === "stale") ? (
              <button
                class="activity-feed__note-action"
                onClick={() => props.onSummaryRetry?.(props.row)}
              >
                {t("activityFeed.recapRetry")}
              </button>
            ) : undefined}
          </div>
        ) : undefined}
        {phone() ? <InspectRun /> : undefined}
      </div>
      <ActivitySessionAccessories
        context={context}
        sessionKey={scopedSessionArtifactKey(props.row.key, agentId())}
        agentId={agentId()}
      />
      <ActivitySessionMedia
        context={context}
        sessionKey={scopedSessionArtifactKey(props.row.key, agentId())}
        agentId={agentId()}
        revision={props.row.updatedAt ?? 0}
        session={props.row}
      />
      {phone() ? undefined : <InspectRun />}
    </div>
  );
}
