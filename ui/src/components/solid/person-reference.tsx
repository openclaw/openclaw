import { createEffect, createMemo, onCleanup, onSettled, Show, untrack } from "solid-js";
import type { UsersListResult } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { buildControlUiUserAvatarPath } from "../../../../src/gateway/control-ui-user-avatar-route.js";
import { selectApplicationSession } from "../../app/agent-selection.ts";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { createPresenceActivityLifecycle } from "../../lib/presence-activity-lifecycle.ts";
import {
  presenceMatchesProfile,
  projectPresencePayload,
  type PresenceViewer,
} from "../../lib/presence-users.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  prepareSessionNavigationHandoff,
  runSessionNavigationIntent,
} from "../../lib/sessions/navigation-handoff.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import {
  isUiGlobalScopeConfigured,
  resolveUiConfiguredMainKey,
  resolveUiDefaultAgentId,
} from "../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { resolveIdentityAvatarView } from "../identity-avatar-view.ts";
import { updatePersonActivityCard } from "../person-activity-card.ts";
import { observePersonActivityData } from "../person-activity-data.ts";
import { personActivityRouting } from "../person-activity-link.ts";
import { createPortaledHovercard, PortaledHovercardController } from "../portaled-hovercard.ts";
import { useIdentityApplication } from "./identity-application.ts";
import { IdentityAvatarImage, identityAvatarState } from "./identity-avatar-image.tsx";
import "../../styles/chat/person-reference.css";

export type PersonReferenceProps = {
  host: HTMLElement;
  profileId?: string;
  label?: string;
};

const active = new WeakMap<Document, () => void>();
let nextCardId = 0;

/** Explicit transcript selections only. The directory remains Gateway-owned, not a UI name index. */
export function PersonReferenceContent(props: PersonReferenceProps) {
  const context = useIdentityApplication();
  const profileId = () => props.profileId ?? "";
  const label = () => props.label ?? "";
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const portal = new PortaledHovercardController(() => close());
  let trigger: HTMLButtonElement | undefined;
  let stopRoute: (() => void) | undefined;
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
    if (active.get(props.host.ownerDocument) === close) {
      active.delete(props.host.ownerDocument);
    }
    activity?.dispose();
    activity = undefined;
    activityExpiry.sync();
    stopRoute?.();
    stopRoute = undefined;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("focusin", outside, true);
    document.removeEventListener("keydown", escape, true);
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
  const stopGateway = gateway?.subscribe(() => untrack(syncConnection));
  untrack(syncConnection);

  createEffect(
    () => ({ profileId: profileId(), label: label(), loading: t("common.loading") }),
    (value, previous) => {
      if (previous && value.profileId !== previous.profileId) {
        close();
      }
      renderCard();
    },
  );

  onSettled(() => {
    activityExpiry.connect();
    return () => activityExpiry.disconnect();
  });
  onCleanup(() => {
    stopGateway?.();
    close();
    connection.dispose();
  });

  function open() {
    if (!trigger || !profileId() || portal.card) {
      return;
    }
    active.get(trigger.ownerDocument)?.();
    active.set(trigger.ownerDocument, close);
    const card = createPortaledHovercard(
      "openclaw-person-reference-" + ++nextCardId,
      "session-progress-hovercard person-activity-hovercard",
    );
    portal.markTrigger(trigger);
    card.addEventListener("pointerleave", portal.handleCardPointerLeave);
    // The unported helper alone owns the portal's children; Solid owns the trigger.
    portal.mount(trigger, card, "vertical", true, () => updatePersonActivityCard(card));
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", escape, true);
    stopRoute = context?.router.subscribe(() => untrack(close));
    if (context) {
      activity = observePersonActivityData(context, () => renderCard());
    }
    person = connection.capture() ? undefined : null;
    renderCard();
    void loadPerson(card);
  }

  async function loadPerson(card: HTMLDivElement) {
    const scope = connection.capture();
    const requestedId = untrack(profileId);
    if (!scope || !context) {
      return;
    }
    let resolved: PresenceViewer | null = null;
    try {
      const { profiles } = await scope.client.request<UsersListResult>("users.list", {});
      // Follow only canonical merge edges returned by the authorized directory.
      const byId = new Map(profiles.map((profile) => [profile.id, profile]));
      const visited = new Set<string>();
      let profile = byId.get(requestedId);
      while (profile?.mergedInto && !visited.has(profile.id)) {
        visited.add(profile.id);
        profile = byId.get(profile.mergedInto);
      }
      if (profile && !profile.mergedInto) {
        resolved = {
          id: profile.id,
          identity: { type: "profile", id: profile.id },
          name:
            profile.displayName?.trim() ||
            profile.githubIdentity?.login ||
            untrack(() => t("presence.card.person")),
          avatarUrl: profile.hasAvatar
            ? buildControlUiUserAvatarPath(profile.id, profile.updatedAt)
            : undefined,
          watchedSessions: [],
        };
      }
    } catch {
      // An unavailable or unauthorized profile remains an explicit, unresolved reference.
    }
    if (
      portal.card !== card ||
      untrack(profileId) !== requestedId ||
      !connection.isCurrent(scope)
    ) {
      return;
    }
    person = resolved;
    renderCard();
  }

  function renderCard() {
    untrack(() => {
      activityExpiry.sync();
      const card = portal.card;
      if (!card) {
        return;
      }
      card.setAttribute(
        "aria-label",
        t("presence.card.ariaLabel", { name: person?.name ?? label() }),
      );
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
        untrack(() =>
          updatePersonActivityCard(
            card,
            user && context
              ? {
                  user,
                  sessionData: data,
                  watchAgentId: resolveUiDefaultAgentId(defaults),
                  mainKey: resolveUiConfiguredMainKey(defaults),
                  globalScope: isUiGlobalScopeConfigured(defaults),
                  routing: personActivityRouting(context, close),
                  openSession: (row, agentId) => {
                    const face = resolveSessionPreferredFace(row);
                    const target = sessionNavigationTarget({
                      face,
                      sessionKey: row.key,
                      row,
                      fallbackAgentId: agentId,
                      basePath: context.basePath,
                      mainKey: resolveUiConfiguredMainKey(defaults),
                    });
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
                        prepareSessionNavigationHandoff(
                          context.gateway,
                          target.options.pathname,
                          row.key,
                        );
                        context.navigate(face, target.options);
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
              : person === undefined
                ? t("common.loading")
                : t("chat.mentions.unavailable"),
          ),
        ),
      );
      portal.position();
    });
  }

  // The avatar route follows merged profiles; rendering a mention needs no directory read.
  const avatar = createMemo(() =>
    resolveIdentityAvatarView({
      id: profileId(),
      identity: { type: "profile", id: profileId() },
      name: label().replace(/^@/u, ""),
    }),
  );
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
              untrack(open);
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
        ref={identityAvatarState(avatar)}
        class="markdown-person-reference__avatar"
        aria-hidden="true"
        data-initials={avatar().fallback.initials}
      >
        <Show when={Boolean(avatar().imageUrl)}>
          <IdentityAvatarImage
            view={avatar()}
            fallbackSelector=".markdown-person-reference__avatar"
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
export type PersonReferenceElement = SolidBridgeElement<PersonReferenceProperties>;
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
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-person-reference": PersonReferenceElement;
  }
}
