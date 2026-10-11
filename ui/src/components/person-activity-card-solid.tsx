import { createMemo, For, onSettled, Show } from "solid-js";
import { i18n, t } from "../i18n/index.ts";
import { HoverMarqueeController } from "../lib/hover-marquee-controller.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { presenceConnectionDescriptions } from "../lib/presence-connections.ts";
import {
  presenceMatchesProfile,
  presenceViewerActivity,
  presenceViewerLastActivity,
  presenceUserLabel,
} from "../lib/presence-users.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  loadedPresenceSessions,
  sessionIdentity,
  type PersonCardInput,
  type ScopedSession,
} from "./person-activity-card.ts";
import { personActivityLink } from "./person-activity-link.ts";
import { Icon } from "./solid/icon.tsx";
import { ViewerAvatar } from "./solid/viewer-facepile.tsx";
import "./elapsed-time.ts";

function Elapsed(props: {
  timestamp: number;
  display?: "compact" | "minute-compact" | "single-unit";
}) {
  const date = () => new Date(props.timestamp);
  return (
    <time
      datetime={date().toISOString()}
      title={date().toLocaleString(i18n.getLocale())}
      aria-label={
        props.display === "minute-compact" ? undefined : date().toLocaleString(i18n.getLocale())
      }
    >
      <openclaw-elapsed-time
        prop:startMs={props.timestamp}
        prop:minimumUnit={props.display === "minute-compact" ? "minute" : "second"}
        prop:singleUnit={props.display === "single-unit"}
      />
    </time>
  );
}

function RecentSessionName(props: { name: string }) {
  let label!: HTMLSpanElement;
  onSettled(() => {
    const marquee = new HoverMarqueeController();
    marquee.update(label, { delay: 250, speed: 80 }, "person-activity-card__session-name");
    return () => marquee.disconnect();
  });
  return (
    <span
      class="person-activity-card__session-name hover-marquee"
      ref={(element) => {
        label = element;
      }}
    >
      <span class="hover-marquee__text">{props.name}</span>
    </span>
  );
}

function SessionLink(props: { session: ScopedSession; input: PersonCardInput; recent: boolean }) {
  const row = () => props.session.row;
  const name = () => resolveSessionDisplayName(row().key, row());
  const target = () =>
    sessionNavigationTarget({
      face: resolveSessionPreferredFace(row()),
      sessionKey: row().key,
      fallbackAgentId: props.session.agentId,
      basePath: props.input.routing.basePath,
      row: row(),
      mainKey: props.input.mainKey,
    });
  return (
    <a
      class="person-activity-card__session session-row-host"
      href={target().href}
      onClick={(event: MouseEvent) => {
        if (shouldHandleNavigationClick(event)) {
          event.preventDefault();
          props.input.openSession(row(), props.session.agentId);
        }
      }}
    >
      <span class="person-activity-card__session-icon" aria-hidden="true">
        <Icon name="messageSquare" />
      </span>
      <span class="person-activity-card__session-copy">
        {props.recent ? (
          <RecentSessionName name={name()} />
        ) : (
          <span class="person-activity-card__session-name person-activity-card__session-name--multiline">
            {name()}
          </span>
        )}
        <Show when={row().updatedAt != null}>
          <span class="person-activity-card__session-age">
            <Elapsed timestamp={row().updatedAt!} display="single-unit" />
          </span>
        </Show>
      </span>
    </a>
  );
}

function Sessions(props: {
  sessions: readonly ScopedSession[];
  input: PersonCardInput;
  recent: boolean;
}) {
  return (
    <Show when={props.recent || props.sessions.length > 0}>
      <section class="person-activity-card__section">
        <h3>{t(props.recent ? "presence.card.recentSessions" : "presence.card.viewingNow")}</h3>
        <Show
          when={props.sessions.length > 0}
          fallback={
            <p class="person-activity-card__muted">{t("presence.card.noRecentSessions")}</p>
          }
        >
          <div class="person-activity-card__sessions">
            <For
              each={props.sessions.slice(0, 3)}
              keyed={(session) => sessionIdentity(session.row.key, session.agentId, props.input)}
            >
              {(session) => (
                <SessionLink session={session()} input={props.input} recent={props.recent} />
              )}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}

export function PersonActivityCard(props: PersonCardInput) {
  let recentSessionKeys: string[] | undefined;
  const facts = createMemo(() => {
    const user = props.user;
    const label = presenceUserLabel(user, t("presence.card.person"));
    const entries = user.entries ?? [];
    const onlineTimes = entries.flatMap((entry) =>
      entry.onlineSince === undefined ? [] : [entry.onlineSince],
    );
    const watched = new Set(
      user.watchedSessions.map((key) => sessionIdentity(key, props.watchAgentId, props)),
    );
    const unique = loadedPresenceSessions(props);
    const newestFirst = (a: ScopedSession, b: ScopedSession) =>
      (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0) ||
      sessionIdentity(a.row.key, a.agentId, props).localeCompare(
        sessionIdentity(b.row.key, b.agentId, props),
      );
    const viewing = [...watched].flatMap((key) => unique.get(key) ?? []).toSorted(newestFirst);
    const recent = (
      recentSessionKeys?.flatMap((key) => unique.get(key) ?? []) ?? [...unique.values()]
    ).filter(
      ({ row, agentId }) =>
        !watched.has(sessionIdentity(row.key, agentId, props)) &&
        [row.owner?.actor, row.createdActor].some((actor) =>
          presenceMatchesProfile(user, actor?.identity),
        ),
    );
    if (!recentSessionKeys) {
      recent.sort(newestFirst);
    }
    // The open card freezes its recent selection; retired identities are never backfilled.
    if (recentSessionKeys || props.sessionData?.sessionsResult) {
      recentSessionKeys = recent
        .slice(0, 3)
        .map(({ row, agentId }) => sessionIdentity(row.key, agentId, props));
    }
    return {
      label,
      viewing,
      recent: recentSessionKeys ? recent : [],
      observed: user.entries !== undefined,
      offline: user.entries?.length === 0,
      onlineSince: onlineTimes.length ? Math.min(...onlineTimes) : undefined,
      lastActivityAt: presenceViewerLastActivity(user),
      activity: presenceViewerActivity(user),
      where: presenceConnectionDescriptions(entries),
      zones: [
        ...new Set(
          entries.flatMap((entry) => (entry.timeZone?.trim() ? [entry.timeZone.trim()] : [])),
        ),
      ].toSorted(),
      activityLink: personActivityLink(user.identity?.id, props.routing, label.name),
    };
  });
  return (
    <div class="person-activity-card">
      <header class="person-activity-card__header">
        <ViewerAvatar user={props.user} markAsViewer={false} variant="footer" aria-hidden="true" />
        <div>
          <h2>{facts().label.name}</h2>
          <Show when={facts().observed}>
            <span
              class={[
                "person-activity-card__status",
                `person-activity-card__status--${facts().offline ? "offline" : facts().activity}`,
              ]}
            >
              <span aria-hidden="true" />
              {facts().offline ? (
                t("presence.offline")
              ) : facts().onlineSince === undefined ? (
                t("presence.rosterTitle")
              ) : (
                <>
                  {t("presence.card.onlineFor")}{" "}
                  <Elapsed timestamp={facts().onlineSince!} display="minute-compact" />
                </>
              )}
              {!facts().offline && facts().activity !== "unknown"
                ? ` · ${t(facts().activity === "active" ? "presence.active" : "presence.idle")}`
                : null}
            </span>
          </Show>
        </div>
      </header>
      <Show when={facts().label.isSharedOwner}>
        <p class="person-activity-card__hint person-activity-card__muted">
          {t("presence.sharedOwner.hint")}
        </p>
      </Show>
      <Show when={facts().observed && !facts().offline}>
        <dl class="person-activity-card__facts">
          <Show when={facts().where.length > 0 || facts().zones.length > 0}>
            <div>
              <dt>{t("presence.card.where")}</dt>
              <dd>
                <For each={facts().where}>{(description) => <span>{description}</span>}</For>
                <For each={facts().zones}>
                  {(zone) => <small>{t("presence.card.reportedTimeZone", { zone })}</small>}
                </For>
              </dd>
            </div>
          </Show>
          <div>
            <dt>{t("presence.card.lastActivity")}</dt>
            <dd>
              {facts().lastActivityAt === undefined ? (
                t("presence.card.notObserved")
              ) : (
                <span>
                  <Elapsed timestamp={facts().lastActivityAt!} /> {t("presence.card.ago")}
                </span>
              )}
            </dd>
          </div>
        </dl>
      </Show>
      <Sessions sessions={facts().viewing} input={props} recent={false} />
      <Sessions sessions={facts().recent} input={props} recent />
      <Show when={facts().activityLink}>
        {(link) => (
          <footer>
            <a href={link().href} onClick={(event: MouseEvent) => link().open(event)}>
              {t("presence.card.viewActivity")}
              <span aria-hidden="true">
                <Icon name="chevronRight" />
              </span>
            </a>
          </footer>
        )}
      </Show>
    </div>
  );
}
