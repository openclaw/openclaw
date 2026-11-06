import { render, spread } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import { createGatewayConnectionLifecycle } from "../../lib/gateway-connection-lifecycle.ts";
import { createIdleImport } from "../../lib/idle-import.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { createPortaledHovercard, createPortaledHovercardOwner } from "../portaled-hovercard.ts";
import { IdentityAvatarImage, createIdentityAvatarPresentation } from "./identity-avatar-image.tsx";
import { useIdentityAvatarView } from "./identity-avatar-view.ts";
import type { createPersonReferenceCard } from "./person-reference.runtime.ts";
import "../../styles/chat/person-reference.css";

type ActivePersonCard = {
  host: HTMLElement;
  close: () => void;
  refresh: () => void;
};

const active = new WeakMap<Document, ActivePersonCard>();
let nextCardId = 0;

/** Explicit transcript selections only. The directory remains Gateway-owned, not a UI name index. */
function PersonReferenceContent(props: PersonReferenceProperties, host: HTMLElement) {
  host.style.display = "contents";
  const context = useOptionalApplication();
  const profileId = () => props.profileId ?? "";
  const label = () => props.label ?? "";
  const connection = createGatewayConnectionLifecycle({ client: null, phase: "stopped" });
  const portal = createPortaledHovercardOwner(() => close());
  let trigger: HTMLButtonElement | undefined;
  let stopRoute: (() => void) | undefined;
  let stopGateway: (() => void) | undefined;
  let stopEvents: (() => void)[] = [];
  let runtime: ReturnType<typeof createPersonReferenceCard> | undefined;
  let disposePending: (() => void) | undefined;
  const cardCode = createIdleImport(() => import("./person-reference.runtime.ts"));

  function close() {
    if (active.get(host.ownerDocument)?.close === close) {
      active.delete(host.ownerDocument);
    }
    runtime?.dispose();
    runtime = undefined;
    disposePending?.();
    disposePending = undefined;
    stopRoute?.();
    stopRoute = undefined;
    stopGateway?.();
    stopGateway = undefined;
    connection.invalidate();
    stopEvents.forEach((stop) => stop());
    stopEvents = [];
    portal.reset();
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.setAttribute("aria-haspopup", "dialog");
  }

  function outside(event: Event) {
    if (!event.composedPath().some((target) => target === host || target === portal.card)) {
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

  const syncConnection = () => {
    if (context && connection.transition(context.gateway.snapshot)) {
      close();
    } else {
      renderCard();
    }
  };
  onSettled(() => {
    return () => {
      cardCode.dispose();
      close();
      connection.dispose();
    };
  });

  function open() {
    if (!trigger || !profileId() || portal.card) {
      return;
    }
    active.get(trigger.ownerDocument)?.close();
    // Closed mentions have no connection-bound work. Start from the live snapshot at admission.
    if (context) {
      connection.transition(context.gateway.snapshot);
      stopGateway = context.gateway.subscribe(syncConnection);
    }
    active.set(trigger.ownerDocument, { host, close, refresh: renderCard });
    const card = createPortaledHovercard(
      "openclaw-person-reference-" + ++nextCardId,
      "session-progress-hovercard person-activity-hovercard",
    );
    portal.markTrigger(trigger);
    portal.mount(trigger, card, "vertical", true, () => runtime?.dispose());
    if (portal.card !== card) {
      close();
      return;
    }
    let showUnavailable: (() => void) | undefined;
    disposePending = render(() => {
      const [failed, setFailed] = createSignal(false);
      showUnavailable = () => setFailed(true);
      spread(card, () => ({ "aria-label": t("presence.card.ariaLabel", { name: label() }) }), true);
      return (
        <div class="person-reference__status" role="status">
          {t(
            !failed() && context && connection.capture()
              ? "common.loading"
              : "chat.mentions.unavailable",
          )}
        </div>
      );
    }, card);
    stopEvents = [
      listen(card, "pointerleave", portal.handleCardPointerLeave),
      listen(document, "pointerdown", outside, true),
      listen(document, "focusin", outside, true),
      listen(document, "keydown", escape, true),
    ];
    // Navigation ends the portaled card before its retained transcript can render again.
    stopRoute = context?.router.subscribe(close);
    renderCard();
    const scope = connection.capture();
    void cardCode.load().then(
      ({ createPersonReferenceCard }) => {
        if (!host.isConnected || portal.card !== card || (scope && !connection.isCurrent(scope))) {
          return;
        }
        disposePending?.();
        disposePending = undefined;
        runtime = createPersonReferenceCard({
          host,
          card,
          context,
          profileId,
          label,
          connection,
          portal,
          close,
        });
      },
      () => {
        if (portal.card === card) {
          showUnavailable?.();
          portal.position();
        }
      },
    );
  }
  function renderCard() {
    const card = portal.card;
    if (!card) {
      return;
    }
    if (runtime) {
      runtime.refresh();
      return;
    }
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
defineSolidBridge<PersonReferenceProperties>("openclaw-person-reference", PersonReferenceContent, {
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
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-person-reference": PersonReferenceElement;
  }
}
