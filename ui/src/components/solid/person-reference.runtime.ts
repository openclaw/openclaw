import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { createPresenceActivityLifecycle } from "../../lib/presence-activity-lifecycle.ts";
import {
  presenceMatchesProfile,
  projectPresencePayload,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { profileAvatarUrl, profileDirectory } from "../../lib/profile-directory.ts";
import { t } from "../../lib/reactive/i18n.ts";
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
  const activityExpiry = createPresenceActivityLifecycle(() => {
    const profile = context ? profileDirectory(context.gateway).get(profileId()) : undefined;
    return projectPresencePayload(activity?.data?.presencePayload).users.filter((user) =>
      presenceMatchesProfile(user, profile && { type: "profile", id: profile.id }),
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
          watchedSessions: [],
        };
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
                      const face = resolveSessionPreferredFace(row);
                      close();
                      runSessionNavigationIntent(host, {
                        agentId,
                        face,
                        sessionKey: row.key,
                        commit: () => {
                          if (
                            !scope ||
                            context.router.getState().location !== route ||
                            !connection.isCurrent(scope)
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
