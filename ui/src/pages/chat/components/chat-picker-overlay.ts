import { createEffect, createSignal, untrack } from "solid-js";
import { createOverlayAnchor } from "../../../components/overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../../../components/overlay-lifecycle.ts";
import { registryFor } from "../../../components/overlay-registry.ts";
import "../../../components/solid/overlay.css";
import { consumeTooltipEscape } from "../../../components/tooltip.ts";
import { acquireNativeOverlaySurface } from "../../../lib/native-overlay-occlusion.ts";
import { clearChatModelSearchOnEscape } from "./chat-model-picker-search.ts";

const MOBILE_COMPOSER_OVERLAY_QUERY =
  "(max-width: 640px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

const composerPickerDismissals = new WeakMap<
  Document,
  { owners: Set<symbol>; dispose: () => void }
>();
const CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT = "openclaw-composer-dismiss-invocations";
const INVOCATION_MENUS = ".agent-chat__input > :is(.slash-menu, .skill-menu)";
let nextPickerId = 0;

/** Keep native details selectors while the shared overlay owns visibility and dismissal. */
function bindChatPickerOverlay(
  details: HTMLDetailsElement,
  onOpenChange?: (details: HTMLDetailsElement) => void,
): () => void {
  const trigger = details.querySelector<HTMLElement>(":scope > summary")!;
  const surface = details.querySelector<HTMLElement>(":scope > [data-anchored-overlay]")!;
  const overlay = createOverlay(`chat-picker-${++nextPickerId}`, findOverlayParent(trigger), {
    exclusiveGroup: "menu",
    interactionElements: () => [details],
    acquireOcclusion: acquireNativeOverlaySurface,
    onEscape: clearChatModelSearchOnEscape,
  });
  trigger.id = `${overlay.id}-trigger`;
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-controls", overlay.id);
  surface.id = overlay.id;
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-labelledby", trigger.id);
  overlay.bindSurface(surface);
  overlay.bindTrigger(trigger);
  const anchor = createOverlayAnchor(surface, { sameRoot: true });
  const sync = () => {
    const mobile = details.ownerDocument.defaultView?.matchMedia?.(
      MOBILE_COMPOSER_OVERLAY_QUERY,
    ).matches;
    anchor.update(
      mobile ? (details.closest<HTMLElement>(".agent-chat__input") ?? trigger) : trigger,
      "top-end",
    );
    if (!overlay.request(details.open)) {
      details.open = overlay.open;
    }
  };
  details.setAttribute("data-chat-native-picker", "");
  let lastOpen = overlay.open;
  const stop = overlay.subscribe((open) => {
    details.open = open;
    if (open !== lastOpen) {
      lastOpen = open;
      untrack(() => onOpenChange?.(details));
    }
  });
  const toggle = () => {
    if (details.open === overlay.open) {
      return;
    }
    sync();
  };
  const activate = (event: MouseEvent) => {
    if (event.defaultPrevented || !event.composedPath().includes(trigger)) {
      return;
    }
    event.preventDefault();
    if (trigger.getAttribute("aria-disabled") === "true") {
      return;
    }
    details.open = !details.open;
    toggle();
  };
  details.addEventListener("click", activate);
  details.addEventListener("toggle", toggle);
  sync();
  return () => {
    details.removeEventListener("click", activate);
    details.removeEventListener("toggle", toggle);
    stop();
    details.removeAttribute("data-chat-native-picker");
    overlay.dispose();
    anchor.dispose();
  };
}

/** The ref only publishes the node; the component owner binds and releases its surface. */
export function createChatPickerOverlay(
  onOpenChange?: (details: HTMLDetailsElement) => void,
): (details: HTMLDetailsElement) => void {
  const [element, setElement] = createSignal<HTMLDetailsElement>();
  createEffect(element, (details) =>
    details ? bindChatPickerOverlay(details, onOpenChange) : undefined,
  );
  return (details) => setElement(details);
}

// Split panes and Home can overlap New Session. Keep one document listener set
// until the last mounted composer releases it.
export function installChatComposerPickerDismissal(ownerDocument: Document): () => void {
  const dismissal = composerPickerDismissals.get(ownerDocument) ?? {
    owners: new Set<symbol>(),
    dispose: connectChatComposerPickerDismissal(ownerDocument),
  };
  composerPickerDismissals.set(ownerDocument, dismissal);
  const owner = Symbol("composer picker");
  dismissal.owners.add(owner);
  return () => {
    if (!dismissal.owners.delete(owner) || dismissal.owners.size > 0) {
      return;
    }
    composerPickerDismissals.delete(ownerDocument);
    dismissal.dispose();
  };
}

function connectChatComposerPickerDismissal(ownerDocument: Document): () => void {
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };

  function dismissChatComposerPickersOutside(event: PointerEvent): void {
    const path = event.composedPath();
    for (const menu of ownerDocument.querySelectorAll<HTMLElement>(INVOCATION_MENUS)) {
      if (!path.includes(menu)) {
        menu
          .closest(".agent-chat__input")
          ?.dispatchEvent(new CustomEvent(CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT));
      }
    }
  }

  function dismissChatComposerPickersOnEscape(event: KeyboardEvent): void {
    if (
      event.isComposing ||
      event.keyCode === 229 ||
      event.defaultPrevented ||
      consumeTooltipEscape(event, ownerDocument) ||
      event.key !== "Escape" ||
      ownerDocument.querySelector(".shell-nav[aria-modal='true']")
    ) {
      return;
    }
    if (registryFor(ownerDocument).stack.at(-1)?.open) {
      return;
    }
    const invocationComposer = ownerDocument
      .querySelector<HTMLElement>(INVOCATION_MENUS)
      ?.closest<HTMLElement>(".agent-chat__input");
    if (!invocationComposer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    invocationComposer.dispatchEvent(new CustomEvent(CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT));
    invocationComposer
      .querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
      ?.focus({ preventScroll: true });
  }

  ownerDocument.addEventListener("pointerdown", dismissChatComposerPickersOutside, options);
  // Native surfaces consume Escape before invocation menus beneath them.
  ownerDocument.defaultView?.addEventListener(
    "keydown",
    dismissChatComposerPickersOnEscape,
    options,
  );

  return () => controller.abort();
}
