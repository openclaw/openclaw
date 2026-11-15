import "../styles/session-progress-hovercard.css";
import "../styles/person-activity-card.css";
import { render, spread } from "@solidjs/web";
import { createMemo, createSignal, Errored, For, Loading, runWithOwner, Show } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import { registerChatComposerEnglish } from "../i18n/locales/en-chat-composer.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import {
  presenceMatchesProfile,
  presenceViewerActivity,
  presenceViewerLastActivity,
  presenceUserLabel,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import { registerEnglishCatalog, getLocale, i18nRevision, t } from "../lib/reactive/i18n.ts";
import { createResizeObserver } from "../lib/reactive/observers.ts";
import { readVisibleTime } from "../lib/reactive/visible-clock.ts";
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
import { HoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { isSubagentsPanelSession } from "../pages/chat/chat-spawned-subagent.ts";
import { ElapsedTime } from "./elapsed-time.tsx";
import type { PersonActivityData } from "./person-activity-data.ts";
import { personActivityLink, type PersonActivityRouting } from "./person-activity-link.ts";
import {
  controlsForHovercard,
  createHovercardControlRef,
  HovercardControlsContext,
} from "./portaled-hovercard-focus.ts";
import "./solid/viewer-facepile.tsx";

registerEnglishCatalog(registerChatComposerEnglish);

type ScopedSession = { row: GatewaySessionRow; agentId: string };
export type PersonCardInput = {
  user: PresenceViewer;
  ariaName?: string;
  sessionData: PersonActivityData | undefined;
  watchAgentId: string;
  mainKey: string;
  globalScope: boolean;
  routing: PersonActivityRouting;
  openSession: (
    row: GatewaySessionRow,
    agentId: string,
    options: ReturnType<typeof sessionNavigationTarget>["options"],
  ) => void;
};

/** Loaded, caller-visible roster facts, paired with their owning list scope. */
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

function Elapsed(props: { timestamp: number }) {
  const date = createMemo(() => new Date(props.timestamp));
  const localizedDate = createMemo(() => date().toLocaleString(getLocale()));
  return (
    <time datetime={date().toISOString()} title={localizedDate()} aria-label={localizedDate()}>
      <ElapsedTime startMs={props.timestamp} singleUnit />
    </time>
  );
}

/** Their wall-clock time, shown only when it differs from the viewer's. */
function LocalTime(props: { zone: string }) {
  const formatters = createMemo(() => {
    const options = { hour: "numeric", minute: "2-digit" } as const;
    try {
      return [
        new Intl.DateTimeFormat(getLocale(), { ...options, timeZone: props.zone }),
        new Intl.DateTimeFormat(getLocale(), options),
      ];
    } catch {
      // Clients report their own zone; an unrecognized one is omitted.
      return undefined;
    }
  });
  // The card already reads the second clock, so the minute turns over on time.
  const time = createMemo(() => {
    const now = readVisibleTime(1_000);
    const [theirs, mine] = formatters() ?? [];
    const value = theirs?.format(now);
    return value === mine?.format(now) ? undefined : value;
  });
  // Emphasize the time within the translated phrase, whatever its word order.
  const parts = createMemo(() => {
    const value = time();
    if (!value) {
      return undefined;
    }
    const text = t("presence.card.localTime", { time: value });
    const at = text.indexOf(value);
    return at < 0
      ? { before: text, value: "", after: "" }
      : {
          before: text.slice(0, at),
          value,
          after: text.slice(at + value.length),
        };
  });
  return (
    <Show when={parts()}>
      {(phrase) => (
        <span class="person-activity-card__clock" title={props.zone}>
          <span class="person-activity-card__separator"> · </span>
          {phrase().before}
          <strong>{phrase().value}</strong>
          {phrase().after}
        </span>
      )}
    </Show>
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
              keyed={({ row, agentId }) => sessionIdentity(row.key, agentId, props.input)}
            >
              {(session) => {
                const name = createMemo(() => {
                  i18nRevision();
                  return resolveSessionDisplayName(session().row.key, session().row);
                });
                const target = () =>
                  sessionNavigationTarget({
                    face: resolveSessionPreferredFace(session().row),
                    sessionKey: session().row.key,
                    fallbackAgentId: session().agentId,
                    basePath: props.input.routing.basePath,
                    row: session().row,
                    mainKey: props.input.mainKey,
                  });
                return (
                  <a
                    ref={createHovercardControlRef()}
                    class="person-activity-card__session session-row-host"
                    href={target().href}
                    onClick={(event) =>
                      handleNavigationClick(event, () => {
                        props.input.openSession(session().row, session().agentId, target().options);
                      })
                    }
                  >
                    <HoverMarquee
                      content={name()}
                      class="person-activity-card__session-name"
                      options={{ delay: 250, speed: 80 }}
                    />
                    <Show when={session().row.updatedAt != null}>
                      <span class="person-activity-card__session-age">
                        <Elapsed timestamp={session().row.updatedAt!} />
                      </span>
                    </Show>
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

function PersonActivityCard(props: { input: PersonCardInput }) {
  const user = () => props.input.user;
  const label = createMemo(() => presenceUserLabel(user(), t("presence.card.person")));
  const activityLink = createMemo(() =>
    personActivityLink(user().identity?.id, props.input.routing, label().name),
  );
  // Undefined means presence has not been observed; an empty snapshot means offline.
  const offline = () => user().entries?.length === 0;
  const activity = createMemo(() => presenceViewerActivity(user()));
  const lastActivityAt = createMemo(() => presenceViewerLastActivity(user()));
  // One clock: the zone of the connection they used most recently.
  const zone = createMemo(() =>
    (user().entries ?? [])
      .filter((entry) => entry.timeZone?.trim())
      .toSorted((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
      ?.timeZone?.trim(),
  );
  let recentSessionKeys: string[] | undefined;
  const sessions = createMemo(() => {
    const input = props.input;
    const watched = new Set(
      input.user.watchedSessions.map((key) => sessionIdentity(key, input.watchAgentId, input)),
    );
    const unique = loadedPresenceSessions(input);
    const newestFirst = (a: ScopedSession, b: ScopedSession) =>
      (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0) ||
      sessionIdentity(a.row.key, a.agentId, input).localeCompare(
        sessionIdentity(b.row.key, b.agentId, input),
      );
    const viewing = [...watched].flatMap((key) => unique.get(key) ?? []).toSorted(newestFirst);
    const { sessionData } = input;
    const recent = (
      recentSessionKeys?.flatMap((key) => unique.get(key) ?? []) ?? [...unique.values()]
    ).filter(
      ({ row, agentId }) =>
        !watched.has(sessionIdentity(row.key, agentId, input)) &&
        !isSubagentsPanelSession(row) &&
        [row.owner?.actor, row.createdActor].some((actor) =>
          presenceMatchesProfile(input.user, actor?.identity),
        ),
    );
    if (!recentSessionKeys) {
      recent.sort(newestFirst);
    }
    // Capture once a roster exists; thereafter retire ineligible identities without backfilling.
    if (recentSessionKeys || sessionData?.sessionsResult) {
      recentSessionKeys = recent
        .slice(0, 3)
        .map(({ row, agentId }) => sessionIdentity(row.key, agentId, input));
    }
    return { viewing, recent: recentSessionKeys ? recent : [] };
  });
  return (
    <div class="person-activity-card">
      <header class="person-activity-card__header">
        <span
          class="person-activity-card__avatar"
          data-presence-activity={
            user().entries === undefined || offline() ? undefined : activity()
          }
        >
          <openclaw-viewer-avatar
            prop:user={user()}
            prop:markAsViewer={false}
            variant="footer"
            aria-hidden="true"
          />
        </span>
        <div class="person-activity-card__identity">
          <h2 title={label().name}>{label().name}</h2>
          <Show when={user().entries !== undefined}>
            <span class="person-activity-card__status">
              {offline() ? (
                t("presence.offline")
              ) : activity() === "active" ? (
                t("presence.active")
              ) : activity() === "idle" ? (
                <>
                  {t("presence.card.idleFor")} <Elapsed timestamp={lastActivityAt()!} />
                </>
              ) : (
                t("presence.rosterTitle")
              )}
              <Show when={!offline() && zone()}>{(value) => <LocalTime zone={value()} />}</Show>
            </span>
          </Show>
        </div>
        <Show when={label().isSharedOwner}>
          <p class="person-activity-card__hint">{t("presence.sharedOwner.hint")}</p>
        </Show>
      </header>
      <Sessions sessions={sessions().viewing} input={props.input} recent={false} />
      <Sessions sessions={sessions().recent} input={props.input} recent={true} />
      <Show when={activityLink()}>
        {(link) => (
          <a
            ref={createHovercardControlRef()}
            class="person-activity-card__activity"
            href={link().href}
            onClick={(event) => link().open(event)}
          >
            {t("presence.card.viewActivity")}
          </a>
        )}
      </Show>
    </div>
  );
}

type CardStatus = { status: "loading" | "unavailable"; name: string };
type ResolvedCard = PersonCardInput | CardStatus;
type CardValue = ResolvedCard | { name: string; read: Promise<ResolvedCard> };

function cardName(input: CardValue) {
  return "user" in input
    ? (input.ariaName ?? presenceUserLabel(input.user, t("presence.card.person")).name)
    : input.name;
}

const cards = new WeakMap<
  HTMLElement,
  { update: (value: CardValue) => void; dispose: () => void }
>();

/** The portal owns one Solid root and retires its retained selection when closed. */
export function updatePersonActivityCard(
  container: HTMLElement,
  input?: CardValue,
  onPosition?: () => void,
) {
  const existing = cards.get(container);
  if (input === undefined) {
    existing?.dispose();
  } else if (existing) {
    existing.update(input);
  } else {
    let update!: (value: CardValue) => void;
    // The portal outlives the caller’s transient render scope.
    const dispose = runWithOwner(null, () =>
      render(() => {
        function PersonCardContents(props: { input: ResolvedCard }) {
          spread(
            container,
            () => ({ "aria-label": t("presence.card.ariaLabel", { name: cardName(props.input) }) }),
            true,
          );
          return (
            <Show
              when={"status" in props.input ? undefined : props.input}
              fallback={
                <div class="person-reference__status" role="status">
                  {"status" in props.input
                    ? t(
                        props.input.status === "loading"
                          ? "common.loading"
                          : "chat.mentions.unavailable",
                      )
                    : ""}
                </div>
              }
            >
              {(current) => <PersonActivityCard input={current()} />}
            </Show>
          );
        }
        const [value, setValue] = createSignal<CardValue>(input, { ownedWrite: true });
        const read = createMemo(() => {
          const current = value();
          return "read" in current ? current.read : current;
        });
        update = setValue;
        if (onPosition) {
          // Translated text can resize the retained card without another owner update.
          createResizeObserver(() => [container], onPosition);
        }
        return (
          <HovercardControlsContext value={controlsForHovercard(container)}>
            <Errored
              fallback={
                <PersonCardContents input={{ status: "unavailable", name: cardName(value()) }} />
              }
            >
              <Loading
                fallback={
                  <PersonCardContents input={{ status: "loading", name: cardName(value()) }} />
                }
              >
                <PersonCardContents input={read()} />
              </Loading>
            </Errored>
          </HovercardControlsContext>
        );
      }, container),
    );
    cards.set(container, {
      update,
      dispose: () => {
        cards.delete(container);
        dispose();
      },
    });
  }
}
