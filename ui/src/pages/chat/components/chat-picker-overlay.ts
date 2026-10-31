import { onSettled } from "solid-js";
import { createOverlayAnchor } from "../../../components/overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "../../../components/overlay-lifecycle.ts";
import { registryFor } from "../../../components/overlay-registry.ts";
import "../../../components/solid/overlay.css";
import { consumeTooltipEscape } from "../../../components/tooltip.ts";
import { acquireNativeOverlaySurface } from "../../../lib/native-overlay-occlusion.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { clearChatModelSearchOnEscape } from "./chat-model-picker-search.ts";

const MOBILE_COMPOSER_OVERLAY_QUERY =
  "(max-width: 640px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

const composerPickerDismissals = new WeakMap<
  Document,
  { owners: Set<symbol>; dispose: () => void }
>();
const CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT = "openclaw-composer-dismiss-invocations";
type InvocationMenu = { element: HTMLElement; getTextarea: () => HTMLTextAreaElement | null };
const invocationMenus = new WeakMap<Document, Set<InvocationMenu>>();
let nextPickerId = 0;

/** Keep native details selectors while the shared overlay owns visibility and dismissal. */
function bindChatPickerOverlay(
  details: HTMLDetailsElement,
  trigger: HTMLElement,
  surface: HTMLElement,
  onOpenChange?: (details: HTMLDetailsElement) => void,
) {
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
    const raisedToolbar =
      details.closest(".agent-chat__composer-shell")?.getAttribute("data-mobile-composer") ===
      "true";
    anchor.update(
      mobile && !raisedToolbar
        ? (details.closest<HTMLElement>(".agent-chat__input") ?? trigger)
        : trigger,
      "top-end",
    );
    if (!overlay.request(details.open)) {
      details.open = overlay.open;
    }
  };
  details.setAttribute("data-chat-native-picker", "");
  let lastOpen = overlay.open;
  // Mirror each open/close edge into native details and its dismissal callback synchronously.
  const stop = overlay.subscribe((open) => {
    details.open = open;
    if (open !== lastOpen) {
      lastOpen = open;
      onOpenChange?.(details);
    }
  });
  const toggle = () => {
    if (details.open === overlay.open) {
      return;
    }
    sync();
  };
  const activate = (event: Event) => {
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
  sync();
  return {
    onClick: activate,
    onToggle: toggle,
    dispose() {
      stop();
      details.removeAttribute("data-chat-native-picker");
      overlay.dispose();
      anchor.dispose();
    },
  };
}

/** The ref only publishes the node; the component owner binds and releases its surface. */
export function createChatPickerOverlay(onOpenChange?: (details: HTMLDetailsElement) => void) {
  let details!: HTMLDetailsElement;
  let trigger!: HTMLElement;
  let surface!: HTMLElement;
  let binding: ReturnType<typeof bindChatPickerOverlay> | undefined;
  onSettled(() => {
    const current = bindChatPickerOverlay(details, trigger, surface, onOpenChange);
    binding = current;
    return () => {
      binding = undefined;
      current.dispose();
    };
  });
  return {
    details: (element: HTMLDetailsElement) => (details = element),
    trigger: (element: HTMLElement) => (trigger = element),
    surface: (element: HTMLElement) => (surface = element),
    onClick: (event: MouseEvent) => binding?.onClick(event),
    onToggle: () => binding?.onToggle(),
  };
}

/** Invocation menus publish their owned nodes instead of searching other composers' DOM. */
export function registerChatComposerInvocationMenu(
  element: HTMLElement,
  getTextarea: () => HTMLTextAreaElement | null,
): () => void {
  const doc = element.ownerDocument;
  const menus = invocationMenus.get(doc) ?? new Set<InvocationMenu>();
  const entry = { element, getTextarea };
  menus.add(entry);
  invocationMenus.set(doc, menus);
  return () => menus.delete(entry);
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

  function dismissChatComposerPickersOutside(event: Event): void {
    const path = event.composedPath();
    for (const { element } of invocationMenus.get(ownerDocument) ?? []) {
      if (element.isConnected && !path.includes(element)) {
        element.parentElement?.dispatchEvent(
          new CustomEvent(CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT, { bubbles: true }),
        );
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
      // The modal navigation drawer owns focus and Escape within its subtree.
      event
        .composedPath()
        .some((node) => node instanceof Element && node.matches(".shell-nav[aria-modal='true']"))
    ) {
      return;
    }
    if (registryFor(ownerDocument).stack.at(-1)?.open) {
      return;
    }
    const menu = [...(invocationMenus.get(ownerDocument) ?? [])].find(
      ({ element }) => element.isConnected,
    );
    if (!menu) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    menu.element.parentElement?.dispatchEvent(
      new CustomEvent(CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT, { bubbles: true }),
    );
    menu.getTextarea()?.focus({ preventScroll: true });
  }

  listen(ownerDocument, "pointerdown", dismissChatComposerPickersOutside, options);
  // Native surfaces consume Escape before invocation menus beneath them.
  if (ownerDocument.defaultView) {
    listen(
      ownerDocument.defaultView,
      "keydown",
      (event) => {
        if (event instanceof KeyboardEvent) {
          dismissChatComposerPickersOnEscape(event);
        }
      },
      options,
    );
  }

  return () => controller.abort();
}
