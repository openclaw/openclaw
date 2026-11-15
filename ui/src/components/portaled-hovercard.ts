import { onSettled } from "solid-js";
import { composedAncestors, composedParent } from "../lib/navigation-click.ts";
import { listen } from "../lib/reactive/listener.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";
import { controlsForHovercard } from "./portaled-hovercard-focus.ts";
import type { TooltipElement } from "./tooltip.ts";
import { resolveTransientContainer } from "./transient-container.ts";

const CARD_GAP = 10;
const VIEWPORT_PADDING = 12;
// Travel toward an open card: the corridor apex backs off its exit edge so jitter
// there stays inside, and a pointer resting on another trigger hands off to it.
const AIM_APEX_SLACK = 4;
const AIM_REST_MS = 150;

type PortaledHovercardPlacement = "horizontal" | "vertical";
type Point = { x: number; y: number };
// Zag's ray-casting `isPointInPolygon`. Importing it from @zag-js/rect-utils
// brings that module's unused rect helpers into the boot chunk.
function isPointInPolygon(polygon: Point[], { x, y }: Point): boolean {
  let inside = false;
  let previous = polygon.at(-1);
  for (const current of polygon) {
    if (
      previous &&
      current.y > y !== previous.y > y &&
      x < ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x
    ) {
      inside = !inside;
    }
    previous = current;
  }
  return inside;
}

type HovercardAim = {
  apex: Point;
  path: EventTarget[];
  pending: { target: Element; run: () => void } | null;
  restTimer: number | null;
};

// Hold flags stay synchronous: callers write them and immediately decide whether to open or close.
export function createPortaledHovercardOwner(
  close: () => void,
  closeDelayMs = 120,
  dismiss: () => void = close,
) {
  let closeTimer: number | null = null;
  let exitCleanup: (() => void) | null = null;
  let openTimer: number | null = null;
  let stopPositioning: (() => void) | null = null;
  let positionCard: (() => void) | null = null;
  let triggerElement: HTMLElement | null = null;
  let triggerAncestors: Node[] = [];
  let presentationObserver: MutationObserver | undefined;
  let unmountCardContents: (() => void) | null = null;
  let cardAnchor: HTMLElement | null = null;
  let lastPoint: Point | null = null;
  let aim: HovercardAim | null = null;
  const handleCardPointerEnter = (event: PointerEvent) => {
    if (event.currentTarget === portal.card) {
      portal.pointerOverCard = true;
      portal.clearClose();
      stopAim();
    }
  };
  const handleCardFocusIn = (event: FocusEvent) => {
    // A nested Solid root rewrites currentTarget while dispatching delegated focus events.
    if (portal.card && event.composedPath().includes(portal.card)) {
      portal.cardFocusInside = true;
      portal.clearClose();
    }
  };
  const handleCardFocusOut = (event: FocusEvent) => {
    const card = portal.card;
    if (!card || !event.composedPath().includes(card)) {
      return;
    }
    if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) {
      return;
    }
    portal.cardFocusInside = false;
    portal.scheduleClose();
  };

  function stopAim(): void {
    if (aim?.restTimer != null) {
      window.clearTimeout(aim.restTimer);
    }
    aim = null;
  }

  // Leaving the corridor, or resting in it, ends travel: the trigger still under
  // the pointer takes over, otherwise the card closes.
  function finishAim(): void {
    const pending = aim?.pending;
    const path = aim?.path ?? [];
    stopAim();
    if (pending && path.includes(pending.target)) {
      pending.run();
      return;
    }
    portal.scheduleClose();
  }

  // Zag's submenu corridor: the apex, then the card's corners from its near edge.
  function aimsAtCard(current: HovercardAim, event: PointerEvent): boolean {
    const card = portal.card;
    if (!card) {
      return false;
    }
    const side = card.dataset.side;
    const { x, y } = current.apex;
    const { left, top, right, bottom } = card.getBoundingClientRect();
    const tl = { x: left, y: top };
    const tr = { x: right, y: top };
    const br = { x: right, y: bottom };
    const bl = { x: left, y: bottom };
    const polygon =
      side === "left"
        ? [{ x: x + AIM_APEX_SLACK, y }, br, bl, tl, tr]
        : side === "bottom"
          ? [{ x, y: y - AIM_APEX_SLACK }, tr, br, bl, tl]
          : side === "top"
            ? [{ x, y: y + AIM_APEX_SLACK }, bl, tl, tr, br]
            : [{ x: x - AIM_APEX_SLACK, y }, tl, tr, br, bl];
    return isPointInPolygon(polygon, { x: event.clientX, y: event.clientY });
  }

  function armAimRest(current: HovercardAim): void {
    if (current.restTimer !== null) {
      window.clearTimeout(current.restTimer);
    }
    current.restTimer = current.pending ? window.setTimeout(finishAim, AIM_REST_MS) : null;
  }

  const handlePointerMove = (event: PointerEvent) => {
    // Boundary events fire before the move that crosses the boundary, so a
    // pointer exit still sees the last point inside its trigger.
    if (aim && portal.pointerInside) {
      stopAim();
    } else if (aim) {
      aim.path = event.composedPath();
      if (aim.pending && !aim.path.includes(aim.pending.target)) {
        aim.pending = null;
      }
      if (aimsAtCard(aim, event)) {
        armAimRest(aim);
      } else {
        finishAim();
      }
    }
    lastPoint = { x: event.clientX, y: event.clientY };
  };

  function checkPresentation(): boolean {
    if (
      triggerElement &&
      (!triggerElement.isConnected ||
        composedAncestors(triggerElement).some(
          (node) =>
            node instanceof Element &&
            (node.hasAttribute("inert") ||
              node.hasAttribute("hidden") ||
              node.getAttribute("aria-hidden") === "true"),
        ))
    ) {
      dismiss();
      return false;
    }
    return true;
  }

  function observePresentation(): void {
    const ancestors = composedAncestors(triggerElement);
    if (
      ancestors.length === triggerAncestors.length &&
      ancestors.every((node, index) => node === triggerAncestors[index])
    ) {
      return;
    }
    presentationObserver ??= new MutationObserver(() => {
      if (checkPresentation()) {
        observePresentation();
      }
    });
    presentationObserver.disconnect();
    triggerAncestors = ancestors;
    // Only the active trigger's ancestry: retained panes can retire without removal,
    // and document subtree observers cannot see inside a shadow root.
    for (const node of ancestors) {
      presentationObserver.observe(node, {
        childList: true,
        attributes: true,
        attributeFilter: ["inert", "hidden", "aria-hidden", "slot", "name"],
      });
    }
  }

  const portal = {
    // SAFETY: mount and clearCard exclusively fill and retire this initially empty slot.
    card: null as HTMLDivElement | null,
    pointerInside: false,
    pointerOverCard: false,
    focusInside: false,
    cardFocusInside: false,
    explicitHold: false,
    restoringFocus: false,
    handleCardPointerLeave: () => {
      portal.pointerOverCard = false;
      portal.scheduleClose();
    },

    // Document-level Escape: close, and return focus to the trigger when it was in the card.
    handleEscape: (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const trigger = triggerElement;
      const restore = portal.card?.contains(document.activeElement);
      close();
      if (restore) {
        portal.returnFocus(trigger);
      }
    },

    handleTriggerKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      // A portal is outside its trigger's tab sequence. Enter at the first link,
      // then let native Tab traversal own the links inside the card.
      if (event.key !== "Tab" || event.shiftKey || event.composedPath()[0] !== triggerElement) {
        return;
      }
      const first = portal.focusables()[0];
      if (first) {
        event.preventDefault();
        first.focus();
      }
    },

    handleCardKeyDown: (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        (event.key !== "Escape" && event.key !== "Tab") ||
        (event.key === "Tab" && (event.altKey || event.ctrlKey || event.metaKey))
      ) {
        return;
      }
      const focusables = portal.focusables();
      const focused = event.composedPath()[0];
      if (event.key === "Tab" && focused instanceof HTMLElement) {
        const tooltip = focused.closest<TooltipElement>("openclaw-tooltip[open]");
        if (tooltip) {
          const owned = focusables.filter(
            (element) => element.closest("openclaw-tooltip") === tooltip,
          );
          const trigger = owned.findLast((element) => !tooltip.containsRichContent(element));
          const first = owned.find((element) => tooltip.containsRichContent(element));
          // WebKit does not reliably cross from a slotted trigger into the
          // nested top-layer surface. Bridge only that boundary; native Tab
          // still owns traversal within the inspection and the card.
          const destination = event.shiftKey
            ? focused === first
              ? trigger
              : undefined
            : focused === trigger
              ? first
              : undefined;
          if (destination) {
            event.preventDefault();
            destination.focus();
            return;
          }
        }
      }
      const edge = event.shiftKey ? focusables[0] : focusables.at(-1);
      if (event.key === "Tab" && document.activeElement !== edge) {
        return;
      }
      event.preventDefault();
      // Capture before dismissal retires the trigger; focus must not reopen the
      // card being dismissed. Scheduled pointer exit may animate, keyboard exit does not.
      const trigger = triggerElement;
      dismiss();
      portal.returnFocus(trigger);
    },

    renderContents(card: HTMLDivElement, update: () => void): void {
      const focused = card.contains(document.activeElement) ? document.activeElement : null;
      update();
      if (!focused) {
        return;
      }
      // Solid commits roster updates after the caller returns.
      onSettled(() => {
        if (portal.card !== card || document.activeElement !== document.body) {
          return;
        }
        // Live session links can move between sections or disappear after a roster update.
        const replacement =
          focused instanceof HTMLAnchorElement
            ? portal
                .focusables()
                .find((link) => link instanceof HTMLAnchorElement && link.href === focused.href)
            : undefined;
        if (replacement) {
          replacement.focus({ preventScroll: true });
        } else {
          portal.returnFocus(triggerElement);
          portal.focusInside = document.activeElement === triggerElement;
        }
      });
    },

    returnFocus(trigger: HTMLElement | null): void {
      portal.restoringFocus = true;
      trigger?.focus({ preventScroll: true });
      portal.restoringFocus = false;
    },

    get held(): boolean {
      return (
        portal.explicitHold ||
        portal.pointerInside ||
        portal.pointerOverCard ||
        portal.focusInside ||
        portal.cardFocusInside
      );
    },

    schedulePointerExit(event?: PointerEvent): void {
      portal.pointerInside = false;
      stopAim();
      // A mouse leaving toward an open card keeps it while the pointer stays in
      // the corridor, even across other triggers. Leaving the window has no
      // later moves to judge, so it keeps the timed close.
      const anchor = cardAnchor?.getBoundingClientRect();
      if (event && event.pointerType !== "touch" && event.relatedTarget && anchor) {
        // Aim from the pointer's last point inside the trigger: fast moves land
        // the exit event well past the edge, off the line toward the card.
        const from = lastPoint ?? { x: event.clientX, y: event.clientY };
        const next: HovercardAim = {
          apex: {
            x: Math.min(Math.max(from.x, anchor.left), anchor.right),
            y: Math.min(Math.max(from.y, anchor.top), anchor.bottom),
          },
          path: event.composedPath(),
          pending: null,
          restTimer: null,
        };
        if (aimsAtCard(next, event)) {
          aim = next;
          portal.clearClose();
          return;
        }
      }
      // Otherwise keep the grace period: without an exit point the pointer may
      // still be crossing to a card clamped diagonally from its trigger.
      portal.scheduleClose(220);
    },

    // Another trigger hovered on the way to the open card waits until the
    // pointer rests on it or leaves the corridor.
    deferPointerSwitch(event: PointerEvent, target: Element, run: () => void): boolean {
      if (!aim || !aimsAtCard(aim, event)) {
        return false;
      }
      aim.path = event.composedPath();
      aim.pending = { target, run };
      armAimRest(aim);
      return true;
    },

    focusables(): HTMLElement[] {
      return portal.card ? controlsForHovercard(portal.card).read() : [];
    },

    scheduleOpen(delay: number, open: () => void, trigger = triggerElement): void {
      triggerElement = trigger;
      observePresentation();
      openTimer = window.setTimeout(() => {
        openTimer = null;
        if (checkPresentation()) {
          open();
        }
      }, delay);
    },

    clearClose(): void {
      if (closeTimer !== null) {
        window.clearTimeout(closeTimer);
        closeTimer = null;
      }
    },

    scheduleClose(delayMs = closeDelayMs): void {
      portal.clearClose();
      if (portal.held) {
        return;
      }
      // A pending open has no portal gap to cross, so it closes immediately.
      if (!portal.card) {
        close();
        return;
      }
      closeTimer = window.setTimeout(() => {
        closeTimer = null;
        if (!portal.held) {
          close();
        }
      }, delayMs);
    },

    markTrigger(trigger: HTMLElement): void {
      if (triggerElement !== trigger) {
        clearPortaledHovercardTrigger(triggerElement);
      }
      triggerElement = trigger;
      trigger.setAttribute("aria-haspopup", "dialog");
      trigger.setAttribute("aria-expanded", "false");
      observePresentation();
    },

    mount(
      anchor: HTMLElement,
      card: HTMLDivElement,
      placement: PortaledHovercardPlacement,
      observeVisualViewport = true,
      unmountContents?: () => void,
    ): void {
      if (!checkPresentation()) {
        unmountContents?.();
        card.remove();
        return;
      }
      portal.clearCard();
      portal.card = card;
      cardAnchor = anchor;
      unmountCardContents = unmountContents ?? null;
      const trigger = triggerElement ?? anchor;
      const ancestors: Element[] = [];
      for (let ancestor: Element | null = anchor; ancestor; ancestor = composedParent(ancestor)) {
        ancestors.push(ancestor);
      }
      const owner = resolveTransientContainer(ancestors, anchor.ownerDocument);
      if (!owner) {
        portal.reset();
        return;
      }
      const position = () => positionPortaledHovercard(anchor, card, placement);
      positionCard = position;
      let frame: number | null = null;
      const schedulePosition = () => {
        if (frame === null) {
          frame = requestAnimationFrame(() => {
            frame = null;
            position();
          });
        }
      };
      const handleScroll = (event: Event) => {
        const source = event.composedPath()[0];
        if (source === window || source === document) {
          schedulePosition();
          return;
        }
        // Transcript auto-scroll and scrolling inside the card cannot move a
        // sidebar trigger. Only a scroll in its rendered ancestry needs geometry.
        for (let node: Element | null = anchor; node; node = composedParent(node)) {
          if (node === source) {
            schedulePosition();
            return;
          }
        }
      };
      const viewport = observeVisualViewport ? window.visualViewport : null;
      const stopListeners = [
        listen(card, "keydown", { handleEvent: portal.handleCardKeyDown }),
        listen(card, "pointerenter", { handleEvent: handleCardPointerEnter }),
        listen(card, "focusin", { handleEvent: handleCardFocusIn }),
        listen(card, "focusout", { handleEvent: handleCardFocusOut }),
        listen(window, "resize", schedulePosition),
        listen(window, "scroll", handleScroll, true),
        listen(document, "pointermove", handlePointerMove, { capture: true, passive: true }),
        viewport && listen(viewport, "resize", schedulePosition),
        viewport && listen(viewport, "scroll", schedulePosition),
      ];
      owner.append(card);
      promoteToPopoverTopLayer(card, () => [card]);
      trigger.setAttribute("aria-controls", card.id);
      trigger.setAttribute("aria-expanded", "true");
      position();
      stopPositioning = () => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
        }
        stopListeners.forEach((stop) => stop?.());
      };
    },

    clearCard(exitDurationMs = 0): void {
      stopPositioning?.();
      stopPositioning = null;
      positionCard = null;
      cardAnchor = null;
      lastPoint = null;
      stopAim();
      exitCleanup?.();
      exitCleanup = null;
      const card = portal.card;
      const unmountContents = unmountCardContents;
      portal.card = null;
      unmountCardContents = null;
      if (!card) {
        return;
      }
      if (
        exitDurationMs <= 0 ||
        !card.isConnected ||
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        unmountContents?.();
        card.remove();
        return;
      }
      card.dataset.open = "false";
      card.style.pointerEvents = "none";
      const finish = () => {
        window.clearTimeout(exitTimer);
        stopTransition();
        unmountContents?.();
        card.remove();
        if (exitCleanup === finish) {
          exitCleanup = null;
        }
      };
      const handleTransitionEnd = (event: TransitionEvent) => {
        if (event.target === card && event.propertyName === "opacity") {
          finish();
        }
      };
      const stopTransition = listen(card, "transitionend", { handleEvent: handleTransitionEnd });
      const exitTimer = window.setTimeout(finish, exitDurationMs + 50);
      exitCleanup = finish;
    },

    position(): void {
      positionCard?.();
    },

    reset(exitDurationMs = 0): void {
      presentationObserver?.disconnect();
      triggerAncestors = [];
      if (openTimer !== null) {
        window.clearTimeout(openTimer);
        openTimer = null;
      }
      portal.clearClose();
      portal.pointerInside = false;
      portal.pointerOverCard = false;
      portal.focusInside = false;
      portal.cardFocusInside = false;
      portal.explicitHold = false;
      clearPortaledHovercardTrigger(triggerElement);
      portal.clearCard(exitDurationMs);
      triggerElement = null;
    },
  };
  return portal;
}

function clearPortaledHovercardTrigger(trigger: HTMLElement | null): void {
  trigger?.removeAttribute("aria-controls");
  trigger?.removeAttribute("aria-expanded");
  trigger?.removeAttribute("aria-haspopup");
}

export function createPortaledHovercard(id: string, className: string): HTMLDivElement {
  const card = document.createElement("div");
  card.id = id;
  card.className = className;
  card.dataset.open = "true";
  card.setAttribute("role", "dialog");
  return card;
}

function positionPortaledHovercard(
  anchor: HTMLElement,
  card: HTMLDivElement,
  placement: PortaledHovercardPlacement,
): void {
  const anchorRect = anchor.getBoundingClientRect();
  const cardWidth = card.offsetWidth;
  const cardHeight = card.offsetHeight;
  const maxLeft = Math.max(VIEWPORT_PADDING, innerWidth - cardWidth - VIEWPORT_PADDING);
  const maxTop = Math.max(VIEWPORT_PADDING, innerHeight - cardHeight - VIEWPORT_PADDING);
  const fitsBelow = anchorRect.bottom + CARD_GAP + cardHeight + VIEWPORT_PADDING <= innerHeight;
  if (placement === "horizontal") {
    const fitsRight = anchorRect.right + CARD_GAP + cardWidth + VIEWPORT_PADDING <= innerWidth;
    const fitsLeft = anchorRect.left - CARD_GAP - cardWidth >= VIEWPORT_PADDING;
    const fitsAbove = anchorRect.top - CARD_GAP - cardHeight >= VIEWPORT_PADDING;
    // Keep the existing clamp when neither axis has room; switch axes only to clear the trigger.
    if (fitsRight || fitsLeft || (!fitsBelow && !fitsAbove)) {
      const left = fitsRight ? anchorRect.right + CARD_GAP : anchorRect.left - cardWidth - CARD_GAP;
      card.dataset.side = fitsRight ? "right" : "left";
      card.style.left = `${Math.min(Math.max(VIEWPORT_PADDING, left), maxLeft)}px`;
      card.style.top = `${Math.min(Math.max(VIEWPORT_PADDING, anchorRect.top), maxTop)}px`;
      return;
    }
  }
  const side = fitsBelow ? "bottom" : "top";
  const top = fitsBelow ? anchorRect.bottom + CARD_GAP : anchorRect.top - cardHeight - CARD_GAP;
  card.dataset.side = side;
  card.style.left = `${Math.min(Math.max(VIEWPORT_PADDING, anchorRect.left), maxLeft)}px`;
  card.style.top = `${Math.min(Math.max(VIEWPORT_PADDING, top), maxTop)}px`;
}
