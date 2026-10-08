import { html, nothing } from "lit";
import { Directive, directive } from "lit/directive.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { i18n, t } from "../i18n/index.ts";
import { renderHoverMarquee } from "../lib/hover-marquee.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { presenceConnectionDescriptions } from "../lib/presence-connections.ts";
import {
  presenceMatchesProfile,
  presenceViewerActivity,
  presenceViewerLastActivity,
  presenceUserLabel,
  type PresenceViewer,
} from "../lib/presence-users.ts";
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
import { icons } from "./icons.ts";
import type { PersonActivityData } from "./person-activity-data.ts";
import { personActivityLink, type PersonActivityRouting } from "./person-activity-link.ts";
import "./elapsed-time.ts";
import "./viewer-facepile.ts";

type ScopedSession = { row: GatewaySessionRow; agentId: string };
type PersonCardInput = {
  user: PresenceViewer;
  sessionData: PersonActivityData | undefined;
  watchAgentId: string;
  mainKey: string;
  globalScope: boolean;
  routing: PersonActivityRouting;
  openSession: (row: GatewaySessionRow, agentId: string) => void;
};

/** Loaded, caller-visible roster facts, paired with their owning list scope. */
function loadedPresenceSessions(input: PersonCardInput): Map<string, ScopedSession> {
  const sessions = new Map<string, ScopedSession>();
  const data = input.sessionData;
  if (!data) {
    return sessions;
  }
  for (const row of data.sessionsResult?.sessions ?? []) {
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

function elapsed(
  timestamp: number,
  display: "compact" | "minute-compact" | "single-unit" = "compact",
) {
  const date = new Date(timestamp);
  return html`<time
    datetime=${date.toISOString()}
    title=${date.toLocaleString(i18n.getLocale())}
    aria-label=${display === "minute-compact" ? nothing : date.toLocaleString(i18n.getLocale())}
    ><openclaw-elapsed-time
      .startMs=${timestamp}
      .minimumUnit=${display === "minute-compact" ? "minute" : "second"}
      .singleUnit=${display === "single-unit"}
    ></openclaw-elapsed-time
  ></time>`;
}

function renderSessions(
  sessions: readonly ScopedSession[],
  input: PersonCardInput,
  recent: boolean,
) {
  if (!recent && sessions.length === 0) {
    return nothing;
  }
  const title = t(recent ? "presence.card.recentSessions" : "presence.card.viewingNow");
  return html`<section class="person-activity-card__section">
    <h3>${title}</h3>
    ${
      sessions.length
        ? html`<div class="person-activity-card__sessions">
            ${repeat(
              sessions.slice(0, 3),
              ({ row, agentId }) => sessionIdentity(row.key, agentId, input),
              ({ row, agentId }) => {
                const displayName = resolveSessionDisplayName(row.key, row);
                const name = recent
                  ? renderHoverMarquee(displayName, "person-activity-card__session-name", {
                      delay: 250,
                      speed: 80,
                    })
                  : html`<span
                      class="person-activity-card__session-name person-activity-card__session-name--multiline"
                      >${displayName}</span
                    >`;
                const target = sessionNavigationTarget({
                  face: resolveSessionPreferredFace(row),
                  sessionKey: row.key,
                  fallbackAgentId: agentId,
                  basePath: input.routing.basePath,
                  row,
                  mainKey: input.mainKey,
                });
                return html`<a
                  class="person-activity-card__session session-row-host"
                  href=${target.href}
                  @click=${(event: MouseEvent) => {
                    if (!shouldHandleNavigationClick(event)) {
                      return;
                    }
                    event.preventDefault();
                    input.openSession(row, agentId);
                  }}
                  ><span class="person-activity-card__session-icon" aria-hidden="true"
                    >${icons.messageSquare}</span
                  >
                  <span class="person-activity-card__session-copy"
                    >${recent ? keyed(displayName, name) : name}
                    ${
                      row.updatedAt != null
                        ? html`<span class="person-activity-card__session-age"
                            >${elapsed(row.updatedAt, "single-unit")}</span
                          >`
                        : nothing
                    }</span
                  >
                </a>`;
              },
            )}
          </div>`
        : html`<p class="person-activity-card__muted">${t("presence.card.noRecentSessions")}</p>`
    }
  </section>`;
}

// Lit discards this state with the card root; callers need no selection cache or reset path.
class PersonActivityCard extends Directive {
  private recentSessionKeys?: string[];

  render(input: PersonCardInput) {
    const { user } = input;
    const label = presenceUserLabel(user, t("presence.card.person"));
    const activityLink = personActivityLink(user.identity?.id, input.routing, label.name);
    // Undefined means presence has not been observed; an empty snapshot means offline.
    const observed = user.entries !== undefined;
    const offline = user.entries?.length === 0;
    const entries = user.entries ?? [];
    const onlineTimes = entries.flatMap((entry) =>
      entry.onlineSince === undefined ? [] : [entry.onlineSince],
    );
    const onlineSince = onlineTimes.length ? Math.min(...onlineTimes) : undefined;
    const lastActivityAt = presenceViewerLastActivity(user);
    const activity = presenceViewerActivity(user);
    const where = presenceConnectionDescriptions(entries);
    const zones = [
      ...new Set(
        entries.flatMap((entry) => (entry.timeZone?.trim() ? [entry.timeZone.trim()] : [])),
      ),
    ].toSorted();
    const watched = new Set(
      user.watchedSessions.map((key) => sessionIdentity(key, input.watchAgentId, input)),
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
      this.recentSessionKeys?.flatMap((key) => unique.get(key) ?? []) ?? [...unique.values()]
    ).filter(
      ({ row, agentId }) =>
        !watched.has(sessionIdentity(row.key, agentId, input)) &&
        [row.owner?.actor, row.createdActor].some((actor) =>
          presenceMatchesProfile(user, actor?.identity),
        ),
    );
    if (!this.recentSessionKeys) {
      recent.sort(newestFirst);
    }
    // Capture once a roster exists; thereafter retire ineligible identities without backfilling.
    if (this.recentSessionKeys || sessionData?.sessionsResult) {
      this.recentSessionKeys = recent
        .slice(0, 3)
        .map(({ row, agentId }) => sessionIdentity(row.key, agentId, input));
    }
    return html`<div class="person-activity-card">
      <header class="person-activity-card__header">
        <openclaw-viewer-avatar
          .user=${user}
          .markAsViewer=${false}
          variant="footer"
          aria-hidden="true"
        ></openclaw-viewer-avatar>
        <div>
          <h2>${label.name}</h2>
          ${
            observed
              ? html` <span
                  class="person-activity-card__status ${
                    offline
                      ? "person-activity-card__status--offline"
                      : `person-activity-card__status--${activity}`
                  }"
                  ><span aria-hidden="true"></span>${
                    offline
                      ? t("presence.offline")
                      : onlineSince === undefined
                        ? t("presence.rosterTitle")
                        : [
                            t("presence.card.onlineFor"),
                            " ",
                            elapsed(onlineSince, "minute-compact"),
                          ]
                  }${!offline && activity !== "unknown" ? html` · ${t(activity === "active" ? "presence.active" : "presence.idle")}` : nothing}</span
                >`
              : nothing
          }
        </div>
      </header>
      ${label.isSharedOwner ? html`<p class="person-activity-card__hint person-activity-card__muted">${t("presence.sharedOwner.hint")}</p>` : nothing}
      ${
        !observed || offline
          ? nothing
          : html`<dl class="person-activity-card__facts">
              ${
                where.length || zones.length
                  ? html`<div>
                      <dt>${t("presence.card.where")}</dt>
                      <dd>
                        ${where.map((description) => html`<span>${description}</span>`)}${zones.map(
                          (zone) =>
                            html`<small>${t("presence.card.reportedTimeZone", { zone })}</small>`,
                        )}
                      </dd>
                    </div>`
                  : nothing
              }
              <div>
                <dt>${t("presence.card.lastActivity")}</dt>
                <dd>
                  ${
                    lastActivityAt === undefined
                      ? t("presence.card.notObserved")
                      : html`<span>${elapsed(lastActivityAt)} ${t("presence.card.ago")}</span>`
                  }
                </dd>
              </div>
            </dl>`
      }
      ${renderSessions(viewing, input, false)}${renderSessions(this.recentSessionKeys ? recent : [], input, true)}
      ${
        activityLink
          ? html`<footer>
              <a href=${activityLink.href} @click=${activityLink.open}
                >${t("presence.card.viewActivity")}<span aria-hidden="true"
                  >${icons.chevronRight}</span
                ></a
              >
            </footer>`
          : nothing
      }
    </div>`;
  }
}

export const renderPersonActivityCard = directive(PersonActivityCard);
