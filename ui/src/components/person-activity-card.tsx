import { render } from "@solidjs/web";
import { createMemo, createSignal, flush, For, Show } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import { i18n } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { presenceConnectionDescriptions } from "../lib/presence-connections.ts";
import {
  presenceMatchesProfile,
  presenceViewerActivity,
  presenceViewerLastActivity,
  presenceUserLabel,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../lib/sessions/route-navigation.ts";
import {
  canonicalUiSessionKeyForPersistence,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type { PersonActivityData } from "./person-activity-data.ts";
import { personActivityLink, type PersonActivityRouting } from "./person-activity-link.ts";
import { Icon } from "./solid/icon.tsx";
import "./elapsed-time.ts";
import "./viewer-facepile.ts";

type ScopedSession = { row: GatewaySessionRow; agentId: string };
export type PersonCardInput = {
  user: PresenceViewer;
  sessionData: PersonActivityData | undefined;
  watchAgentId: string;
  mainKey: string;
  globalScope: boolean;
  routing: PersonActivityRouting;
  openSession: (row: GatewaySessionRow, agentId: string) => void;
};

function sessionIdentity(key: string, agentId: string, input: PersonCardInput): string {
  const scope = parseAgentSessionKey(key)?.agentId ?? normalizeAgentId(agentId);
  const canonical = canonicalUiSessionKeyForPersistence(
    {
      agentsList: {
        defaultId: scope,
        mainKey: input.mainKey,
        scope: input.globalScope ? "global" : "agent",
      },
    },
    parseAgentSessionKey(key) || key.toLowerCase() === "global" ? key : `agent:${scope}:${key}`,
  );
  return `${scope}\u0000${canonical}`;
}
function loadedPresenceSessions(input: PersonCardInput): Map<string, ScopedSession> {
  const sessions = new Map<string, ScopedSession>();
  for (const row of input.sessionData?.sessionsResult?.sessions ?? []) {
    const agentId = parseAgentSessionKey(row.key)?.agentId ?? row.agentId ?? input.watchAgentId;
    const key = sessionIdentity(row.key, agentId, input);
    if (!sessions.has(key)) {
      sessions.set(key, { row, agentId });
    }
  }
  return sessions;
}
function Elapsed(props: {
  timestamp: number;
  display?: "compact" | "minute-compact" | "single-unit";
}) {
  const date = createMemo(() => new Date(props.timestamp));
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
              {(session) => {
                const displayName = createMemo(() =>
                  resolveSessionDisplayName(session().row.key, session().row),
                );
                const target = createMemo(() =>
                  sessionNavigationTarget({
                    face: resolveSessionPreferredFace(session().row),
                    sessionKey: session().row.key,
                    fallbackAgentId: session().agentId,
                    basePath: props.input.routing.basePath,
                    row: session().row,
                    mainKey: props.input.mainKey,
                  }),
                );
                return (
                  <a
                    class="person-activity-card__session session-row-host"
                    href={target().href}
                    onClick={(event) => {
                      if (!shouldHandleNavigationClick(event)) {
                        return;
                      }
                      event.preventDefault();
                      props.input.openSession(session().row, session().agentId);
                    }}
                  >
                    <span class="person-activity-card__session-icon" aria-hidden="true">
                      <Icon name="messageSquare" />
                    </span>
                    <span class="person-activity-card__session-copy">
                      <Show
                        when={props.recent}
                        fallback={
                          <span class="person-activity-card__session-name person-activity-card__session-name--multiline">
                            {displayName()}
                          </span>
                        }
                      >
                        <Show when={{ name: displayName() }} keyed>
                          {(name) =>
                            renderHoverMarquee(name.name, "person-activity-card__session-name", {
                              delay: 250,
                              speed: 80,
                            })
                          }
                        </Show>
                      </Show>
                      <Show when={session().row.updatedAt != null}>
                        <span class="person-activity-card__session-age">
                          <Elapsed timestamp={session().row.updatedAt!} display="single-unit" />
                        </span>
                      </Show>
                    </span>
                  </a>
                );
              }}
            </For>
          </div>
        </Show>
      </section>
    </Show>
  );
}

export function PersonActivityCard(props: PersonCardInput) {
  // Keep the initial recent identities while this card is open; retire stale rows without backfilling.
  let recentSessionKeys: string[] | undefined;
  const model = createMemo(() => {
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
    if (recentSessionKeys || props.sessionData?.sessionsResult) {
      recentSessionKeys = recent
        .slice(0, 3)
        .map(({ row, agentId }) => sessionIdentity(row.key, agentId, props));
    }
    return {
      label,
      activityLink: personActivityLink(user.identity?.id, props.routing, label.name),
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
      viewing,
      recent: recentSessionKeys ? recent : [],
    };
  });
  return (
    <div class="person-activity-card">
      <header class="person-activity-card__header">
        <openclaw-viewer-avatar
          prop:user={props.user}
          prop:markAsViewer={false}
          variant="footer"
          aria-hidden="true"
        />
        <div>
          <h2>{model().label.name}</h2>
          <Show when={model().observed}>
            <span
              class={[
                "person-activity-card__status",
                model().offline
                  ? "person-activity-card__status--offline"
                  : `person-activity-card__status--${model().activity}`,
              ]}
            >
              <span aria-hidden="true" />
              {model().offline ? (
                t("presence.offline")
              ) : model().onlineSince === undefined ? (
                t("presence.rosterTitle")
              ) : (
                <>
                  {t("presence.card.onlineFor")}{" "}
                  <Elapsed timestamp={model().onlineSince!} display="minute-compact" />
                </>
              )}
              {!model().offline && model().activity !== "unknown" ? (
                <> · {t(model().activity === "active" ? "presence.active" : "presence.idle")}</>
              ) : undefined}
            </span>
          </Show>
        </div>
      </header>
      <Show when={model().label.isSharedOwner}>
        <p class="person-activity-card__hint person-activity-card__muted">
          {t("presence.sharedOwner.hint")}
        </p>
      </Show>
      <Show when={model().observed && !model().offline}>
        <dl class="person-activity-card__facts">
          <Show when={model().where.length > 0 || model().zones.length > 0}>
            <div>
              <dt>{t("presence.card.where")}</dt>
              <dd>
                <For each={model().where}>{(description) => <span>{description}</span>}</For>
                <For each={model().zones}>
                  {(zone) => <small>{t("presence.card.reportedTimeZone", { zone })}</small>}
                </For>
              </dd>
            </div>
          </Show>
          <div>
            <dt>{t("presence.card.lastActivity")}</dt>
            <dd>
              <Show
                when={model().lastActivityAt !== undefined}
                fallback={t("presence.card.notObserved")}
              >
                <span>
                  <Elapsed timestamp={model().lastActivityAt!} /> {t("presence.card.ago")}
                </span>
              </Show>
            </dd>
          </div>
        </dl>
      </Show>
      <Sessions sessions={model().viewing} input={props} recent={false} />
      <Sessions sessions={model().recent} input={props} recent={true} />
      <Show when={model().activityLink}>
        {(link) => (
          <footer>
            <a href={link().href} onClick={(event) => link().open(event)}>
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

export type PersonActivitySurface = PersonCardInput | { status: string };
/** Both portal owners keep one Solid root for the card's retained recent-session selection. */
export function mountPersonActivityCard(container: HTMLElement, initial: PersonActivitySurface) {
  let update: (next: PersonActivitySurface) => void = () => {};
  const dispose = render(() => {
    const [input, setInput] = createSignal(initial);
    update = (next) => {
      setInput(next);
      // The portal restores a displaced link immediately after this update.
      flush();
    };
    const card = createMemo(() => {
      const current = input();
      return "user" in current ? current : null;
    });
    const status = createMemo(() => {
      const current = input();
      return "status" in current ? current.status : "";
    });
    return (
      <Show
        when={card()}
        fallback={
          <div class="person-reference__status" role="status">
            {status()}
          </div>
        }
      >
        {(value) => <PersonActivityCard {...value()} />}
      </Show>
    );
  }, container);
  return { update, dispose };
}
