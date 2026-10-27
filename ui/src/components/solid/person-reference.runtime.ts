import type { UsersMentionableParams, UsersMentionableResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import type { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { createPresenceActivityLifecycle } from "../../lib/presence-activity-lifecycle.ts";
import {
  presenceMatchesProfile,
  projectPresencePayload,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { profileAvatarUrl, profileDirectory } from "../../lib/profile-directory.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import {
  prepareSessionNavigationHandoff,
  runSessionNavigationIntent,
} from "../../lib/sessions/navigation-handoff.ts";
import { resolveSessionPreferredFace } from "../../lib/sessions/route-navigation.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import { updatePersonActivityCard, type PersonCardInput } from "../person-activity-card.tsx";
import { observePersonActivityData } from "../person-activity-data.ts";
import { personActivityRouting } from "../person-activity-link.ts";
import type { createPortaledHovercardOwner } from "../portaled-hovercard.ts";

const SESSION_PEOPLE_FRESH_MS = 5 * 60_000;
const SESSION_PEOPLE_RETRY_MS = 30_000;
const SESSION_PEOPLE_TIMEOUT_MS = 15_000;
const MAX_SESSION_PEOPLE_READS = 16;
type SessionPeopleRead = { expiresAt: number; read: Promise<UsersMentionableResult | null> };
// Keyed by handshake: reconnects and auth changes retire every cached roster.
const sessionPeople = new WeakMap<object, Map<string, SessionPeopleRead>>();

/** Mentionable people for callers without directory access; one bounded read per form and label. */
function readMentionablePeople(
  hello: object,
  client: GatewayBrowserClient,
  params: UsersMentionableParams,
) {
  let reads = sessionPeople.get(hello);
  if (!reads) {
    reads = new Map();
    sessionPeople.set(hello, reads);
  }
  // Session and agent forms name different fields, so their keys never collide.
  const key = JSON.stringify(params);
  const cached = reads.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.read;
  }
  reads.delete(key);
  if (reads.size >= MAX_SESSION_PEOPLE_READS) {
    reads.delete(reads.keys().next().value!);
  }
  const entry: SessionPeopleRead = {
    expiresAt: Number.POSITIVE_INFINITY,
    read: client
      .request<UsersMentionableResult>("users.mentionable", params, {
        timeoutMs: SESSION_PEOPLE_TIMEOUT_MS,
      })
      .then(
        (result) => {
          entry.expiresAt = Date.now() + SESSION_PEOPLE_FRESH_MS;
          return result;
        },
        () => {
          entry.expiresAt = Date.now() + SESSION_PEOPLE_RETRY_MS;
          return null;
        },
      ),
  };
  reads.set(key, entry);
  return entry.read;
}

/** The trigger owns the portal; an opened card owns its directory and activity reads. */
export function createPersonReferenceCard(options: {
  host: HTMLElement;
  card: HTMLDivElement;
  context: ApplicationContext | undefined;
  profileId: () => string;
  label: () => string;
  connection: ReturnType<typeof createGatewayConnectionLifecycle>;
  portal: ReturnType<typeof createPortaledHovercardOwner>;
  close: () => void;
}) {
  const { host, card, context, profileId, label, connection, portal, close } = options;
  let activity: ReturnType<typeof observePersonActivityData> | undefined;
  let fallbackIdentity: PresenceViewer["identity"];
  const activityExpiry = createPresenceActivityLifecycle(() => {
    const profile = context ? profileDirectory(context.gateway).get(profileId()) : undefined;
    return projectPresencePayload(activity?.data?.presencePayload).users.filter((user) =>
      presenceMatchesProfile(
        user,
        profile ? { type: "profile", id: profile.id } : fallbackIdentity,
      ),
    );
  }, renderCard);

  async function loadPerson() {
    const scope = connection.capture();
    const requestedId = profileId();
    if (!scope || !context) {
      return null;
    }
    let resolved: PresenceViewer | null = null;
    try {
      const directory = profileDirectory(context.gateway);
      await directory.load(true);
      const profile = directory.get(requestedId);
      if (profile) {
        resolved = {
          id: profile.id,
          identity: { type: "profile", id: profile.id },
          name:
            profile.displayName?.trim() ||
            profile.githubIdentity?.login ||
            t("presence.card.person"),
          avatarUrl: profileAvatarUrl(profile),
          isGuest: profile.isGuest,
          watchedSessions: [],
        };
      } else if (!directory.result) {
        // Only a refused or failed directory falls back; an answered miss stays unresolved.
        resolved = await resolveSessionPerson(context, scope.client, requestedId);
      }
    } catch {
      // An unavailable or unauthorized profile remains an explicit, unresolved reference.
    }
    if (portal.card !== card || profileId() !== requestedId || !connection.isCurrent(scope)) {
      return null;
    }
    activityExpiry.sync();
    return resolved;
  }

  /**
   * Callers without directory access (guests) still see the mention's person: the session's
   * mention roster, or outside a session the new-session roster for the selected agent, supplies
   * an exact profile match; otherwise the transcript label stands in.
   */
  async function resolveSessionPerson(
    app: ApplicationContext,
    client: GatewayBrowserClient,
    requestedId: string,
  ): Promise<PresenceViewer | null> {
    const sessionKey = host.closest<HTMLElement>("[data-chat-session-key]")?.dataset.chatSessionKey;
    const { snapshot } = app.gateway;
    const { hello, selfUser } = snapshot;
    // Outside a session only callers without directory access fall back; a failed staff
    // directory read keeps its retry status.
    if (!hello || (!sessionKey && hasOperatorReadAccess(hello.auth ?? null))) {
      return null;
    }
    const name = label().replace(/^@/u, "").trim();
    const query = name.slice(0, 128);
    // The agent form lists who could join the caller's new session, exactly what the
    // New Session @ menu offers, so it is read only where that menu is available.
    const params: UsersMentionableParams | undefined = sessionKey
      ? { sessionKey, query }
      : readSessionMethodAccess(snapshot, { method: "sessions.create", sessionScope: true }).allowed
        ? {
            agentId:
              app.agentSelection.state.selectedId ??
              resolveUiDefaultAgentId({ agentsList: app.agents.state.agentsList, hello }),
            query,
          }
        : undefined;
    // The roster excludes the caller, so their own mention never needs the read.
    const user =
      selfUser?.identity?.id === requestedId || !params
        ? undefined
        : (await readMentionablePeople(hello, client, params))?.users.find(
            (candidate) => candidate.profileId === requestedId,
          );
    fallbackIdentity = { type: "profile", id: requestedId };
    return {
      id: requestedId,
      identity: fallbackIdentity,
      name: user?.displayName || name || t("presence.card.person"),
      avatarUrl: user?.avatarUrl,
      watchedSessions: [],
    };
  }

  const personRead = connection.capture() ? loadPerson() : null;

  function renderCard() {
    if (portal.card !== card) {
      return;
    }
    activityExpiry.sync();
    const data = activity?.data;
    const defaults = {
      agentsList: context?.agents.state.agentsList,
      hello: context?.gateway.snapshot.hello,
    };
    const scope = connection.capture();
    const route = context?.router.getState().location;
    const name = label();
    portal.renderContents(card, () =>
      updatePersonActivityCard(
        card,
        personRead && context
          ? {
              name,
              read: personRead.then<PersonCardInput | { status: "unavailable"; name: string }>(
                (person) => {
                  if (!person) {
                    return { status: "unavailable", name };
                  }
                  const presence = projectPresencePayload(data?.presencePayload).users.find(
                    (user) => presenceMatchesProfile(user, person.identity),
                  );
                  return {
                    user: {
                      ...person,
                      name: presence?.name ?? person.name,
                      avatarUrl: presence?.avatarUrl ?? person.avatarUrl,
                      isGuest: presence ? presence.isGuest : person.isGuest,
                      watchedSessions: presence?.watchedSessions ?? [],
                      entries: presence?.entries ?? (data?.presencePayload ? [] : undefined),
                    },
                    ariaName: person.name,
                    sessionData: data,
                    watchAgentId: resolveUiDefaultAgentId(defaults),
                    mainKey: resolveUiConfiguredMainKey(defaults),
                    globalScope: isUiGlobalScopeConfigured(defaults),
                    routing: personActivityRouting(context, close),
                    openSession: (row, agentId, navigation) => {
                      if (!scope || !connection.isCurrent(scope)) {
                        return;
                      }
                      // Closing retires card reads; a deferred navigation keeps Gateway-owned authority.
                      const { client, hello } = context.gateway.snapshot;
                      const face = resolveSessionPreferredFace(row);
                      close();
                      runSessionNavigationIntent(host, {
                        agentId,
                        face,
                        sessionKey: row.key,
                        commit: () => {
                          const snapshot = context.gateway.snapshot;
                          if (
                            !connection.capture() ||
                            context.router.getState().location !== route ||
                            snapshot.phase !== "connected" ||
                            snapshot.client !== client ||
                            snapshot.hello !== hello
                          ) {
                            return false;
                          }
                          prepareSessionNavigationHandoff(
                            context.gateway,
                            navigation.pathname,
                            row.key,
                          );
                          context.navigate(face, navigation);
                          selectApplicationSession({
                            selection: context.agentSelection,
                            gateway: context.gateway,
                            sessionKey: row.key,
                            agentId,
                          });
                          return true;
                        },
                      });
                    },
                  };
                },
              ),
            }
          : { status: "unavailable", name },
        () => portal.position(),
      ),
    );
    portal.position();
  }

  if (context) {
    activity = observePersonActivityData(context, renderCard);
  }
  activityExpiry.connect();
  return {
    refresh: renderCard,
    dispose() {
      activityExpiry.disconnect();
      activity?.dispose();
      updatePersonActivityCard(card);
    },
  };
}
