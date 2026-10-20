import { onSettled, Show } from "solid-js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { createPresenceActivityLifecycle } from "../../lib/presence-activity-lifecycle.ts";
import {
  presenceMatchesProfile,
  projectPresencePayload,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { profileAvatarUrl, profileDirectory } from "../../lib/profile-directory.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
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
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { updatePersonActivityCard } from "../person-activity-card.tsx";
import { observePersonActivityData } from "../person-activity-data.ts";
import { personActivityRouting } from "../person-activity-link.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "../portaled-hovercard.ts";
import { IdentityAvatarImage, createIdentityAvatarPresentation } from "./identity-avatar-image.tsx";
import { useIdentityAvatarView } from "./identity-avatar-view.ts";
import "../../styles/chat/person-reference.css";

type PersonReferenceProps = {
  host: HTMLElement;
  profileId?: string;
  label?: string;
};

type ActivePersonCard = {
  host: HTMLElement;
  close: () => void;
  refresh: () => void;
};

const active = new WeakMap<Document, ActivePersonCard>();
let nextCardId = 0;

/** Explicit transcript selections only. The directory remains Gateway-owned, not a UI name index. */
function PersonReferenceContent(props: PersonReferenceProps) {
  const context = useOptionalApplication();
  const profileId = () => props.profileId ?? "";
  const label = () => props.label ?? "";
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const portal = createPortaledHovercardOwner(() => close());
  let trigger: HTMLButtonElement | undefined;
  let stopRoute: (() => void) | undefined;
  let stopEvents: (() => void)[] = [];
  let person: PresenceViewer | null | undefined;
  let activity: ReturnType<typeof observePersonActivityData> | undefined;
  const activityExpiry = createPresenceActivityLifecycle(
    () =>
      projectPresencePayload(activity?.data?.presencePayload).users.filter((user) =>
        presenceMatchesProfile(user, person?.identity),
      ),
    () => renderCard(),
  );

  function close() {
    if (active.get(props.host.ownerDocument)?.close === close) {
      active.delete(props.host.ownerDocument);
    }
    activity?.dispose();
    activity = undefined;
    activityExpiry.sync();
    stopRoute?.();
    stopRoute = undefined;
    stopEvents.forEach((stop) => stop());
    stopEvents = [];
    portal.reset();
    person = undefined;
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.setAttribute("aria-haspopup", "dialog");
  }

  function outside(event: Event) {
    if (!event.composedPath().some((target) => target === props.host || target === portal.card)) {
      close();
    }
  }

  function escape(event: KeyboardEvent) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const restore = portal.card?.contains(document.activeElement);
    close();
    if (restore) {
      portal.returnFocus(trigger ?? null);
    }
  }

  const gateway = context ? projectGateway(context.gateway) : undefined;
  const syncConnection = () => {
    if (gateway && connection.transition(gateway.read().snapshot)) {
      close();
    } else {
      renderCard();
    }
  };
  onSettled(() => {
    // Retire connection-bound cards while their transcript trigger remains mounted.
    const stopGateway = gateway?.subscribe(syncConnection);
    syncConnection();
    activityExpiry.connect();
    return () => {
      activityExpiry.disconnect();
      stopGateway?.();
      close();
      connection.dispose();
    };
  });

  function open() {
    if (!trigger || !profileId() || portal.card) {
      return;
    }
    active.get(trigger.ownerDocument)?.close();
    active.set(trigger.ownerDocument, { host: props.host, close, refresh: renderCard });
    const card = createPortaledHovercard(
      "openclaw-person-reference-" + ++nextCardId,
      "session-progress-hovercard person-activity-hovercard",
    );
    portal.markTrigger(trigger);
    portal.mount(trigger, card, "vertical", true, () => updatePersonActivityCard(card));
    stopEvents = [
      listen(card, "pointerleave", portal.handleCardPointerLeave),
      listen(document, "pointerdown", outside, true),
      listen(document, "focusin", outside, true),
      listen(document, "keydown", escape, true),
    ];
    // Navigation ends the portaled card before its retained transcript can render again.
    stopRoute = context?.router.subscribe(close);
    if (context) {
      activity = observePersonActivityData(context, () => renderCard());
    }
    person = connection.capture() ? undefined : null;
    renderCard();
    void loadPerson(card);
  }

  async function loadPerson(card: HTMLDivElement) {
    const scope = connection.capture();
    const requestedId = profileId();
    if (!scope || !context) {
      return;
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
      return;
    }
    person = resolved;
    renderCard();
  }

  function renderCard() {
    activityExpiry.sync();
    const card = portal.card;
    if (!card) {
      return;
    }
    const data = activity?.data;
    const presence = projectPresencePayload(data?.presencePayload).users.find((user) =>
      presenceMatchesProfile(user, person?.identity),
    );
    const user = person && {
      ...person,
      name: presence?.name ?? person.name,
      avatarUrl: presence?.avatarUrl ?? person.avatarUrl,
      watchedSessions: presence?.watchedSessions ?? [],
      entries: presence?.entries ?? (data?.presencePayload ? [] : undefined),
    };
    const defaults = {
      agentsList: context?.agents.state.agentsList,
      hello: context?.gateway.snapshot.hello,
    };
    const scope = connection.capture();
    const route = context?.router.getState().location;
    portal.renderContents(card, () =>
      updatePersonActivityCard(
        card,
        user && context
          ? {
              user,
              ariaName: person?.name ?? label(),
              sessionData: data,
              watchAgentId: resolveUiDefaultAgentId(defaults),
              mainKey: resolveUiConfiguredMainKey(defaults),
              globalScope: isUiGlobalScopeConfigured(defaults),
              routing: personActivityRouting(context, close),
              openSession: (row, agentId, options) => {
                const face = resolveSessionPreferredFace(row);
                close();
                runSessionNavigationIntent(props.host, {
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
                    prepareSessionNavigationHandoff(context.gateway, options.pathname, row.key);
                    context.navigate(face, options);
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
            }
          : {
              status: person === undefined ? "loading" : "unavailable",
              name: person?.name ?? label(),
            },
        () => portal.position(),
      ),
    );
    portal.position();
  }

  const avatar = useIdentityAvatarView(() => ({
    id: profileId(),
    identity: { type: "profile", id: profileId() },
    name: label().replace(/^@/u, ""),
  }));
  const presentation = createIdentityAvatarPresentation(avatar);
  return (
    <button
      ref={(element) => {
        trigger = element;
      }}
      type="button"
      class="markdown-person-reference"
      aria-haspopup="dialog"
      aria-expanded="false"
      aria-label={t("presence.card.ariaLabel", { name: label() })}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") {
          return;
        }
        portal.pointerInside = true;
        portal.clearClose();
        portal.scheduleOpen(
          250,
          () => {
            if (portal.held) {
              open();
            }
          },
          trigger,
        );
      }}
      onPointerLeave={() => portal.schedulePointerExit()}
      onPointerCancel={close}
      onContextMenu={close}
      onFocus={() => {
        if (portal.restoringFocus) {
          return;
        }
        portal.focusInside = true;
        portal.clearClose();
        open();
      }}
      onBlur={() => {
        portal.focusInside = false;
        portal.scheduleClose();
      }}
      onKeyDown={portal.handleTriggerKeyDown}
      onClick={() => {
        if (portal.explicitHold) {
          close();
          return;
        }
        portal.explicitHold = true;
        open();
      }}
    >
      <span
        data-avatar-state={presentation.state()}
        class={["markdown-person-reference__avatar", presentation.classes()]}
        aria-hidden="true"
        data-initials={avatar().fallback.initials}
      >
        <Show when={Boolean(avatar().imageUrl)}>
          <IdentityAvatarImage
            view={avatar()}
            onStateChange={presentation.onStateChange}
            ariaHidden={true}
          />
        </Show>
      </span>
      {label().startsWith("@") ? (
        <>
          <span class="markdown-person-reference__prefix" aria-hidden="true">
            @
          </span>
          {label().slice(1)}
        </>
      ) : (
        label()
      )}
    </button>
  );
}

type PersonReferenceProperties = { profileId: string; label: string };
type PersonReferenceElement = SolidBridgeElement<PersonReferenceProperties>;
defineSolidBridge<PersonReferenceProperties>(
  "openclaw-person-reference",
  (props, host) => {
    host.style.display = "contents";
    return <PersonReferenceContent {...props} host={host} />;
  },
  {
    properties: {
      profileId: { default: "", attribute: "profile-id" },
      label: { default: "" },
    },
    propertyChanged(host, key) {
      const current = active.get(host.ownerDocument);
      if (current?.host !== host) {
        return;
      }
      if (key === "profileId") {
        current.close();
      } else if (key === "label") {
        current.refresh();
      }
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-person-reference": PersonReferenceElement;
  }
}
