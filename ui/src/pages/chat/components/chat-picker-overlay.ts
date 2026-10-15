import { createEffect, createSignal } from "solid-js";
import { createOverlayAnchor } from "../../../components/overlay-anchor.ts";
import {
  createOverlay,
  findOverlayParent,
  type Overlay,
} from "../../../components/overlay-lifecycle.ts";
import { registryFor } from "../../../components/overlay-registry.ts";
import "../../../components/solid/overlay.css";
import { consumeTooltipEscape } from "../../../components/tooltip.ts";
import { acquireNativeOverlaySurface } from "../../../lib/native-overlay-occlusion.ts";
import { clearChatModelSearchOnEscape } from "./chat-model-picker-search.ts";

const MOBILE_COMPOSER_OVERLAY_QUERY =
  "(max-width: 640px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

const pointerOpenedDropdowns = new WeakSet<HTMLElement>();
const composerPickerDismissals = new WeakMap<
  Document,
  { owners: Set<symbol>; dispose: () => void }
>();
const POINTER_RESTORED_FOCUS_ATTRIBUTE = "data-chat-pointer-restored-focus";
const POINTER_OPENED_PICKER_ATTRIBUTE = "data-chat-pointer-opened-picker";
const CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT = "openclaw-composer-dismiss-invocations";
const LEGACY_INVOCATION_MENUS =
  ".agent-chat__input > :is(.slash-menu, .skill-menu, .emoji-menu-popup:not([popover]))";
const nativePickers = new WeakMap<HTMLDetailsElement, Overlay>();
let nextPickerId = 0;

/** Keep native details selectors while the shared overlay owns visibility and dismissal. */
function bindChatPickerOverlay(details: HTMLDetailsElement): () => void {
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
  const anchor = createOverlayAnchor(surface);
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
  nativePickers.set(details, overlay);
  details.setAttribute("data-chat-native-picker", "");
  const stop = overlay.subscribe((open) => {
    details.open = open;
  });
  const toggle = () => {
    if (details.open) {
      closeOtherChatComposerPickers(details);
    }
    sync();
  };
  details.addEventListener("toggle", toggle);
  sync();
  return () => {
    details.removeEventListener("toggle", toggle);
    stop();
    nativePickers.delete(details);
    details.removeAttribute("data-chat-native-picker");
    overlay.dispose();
    anchor.dispose();
  };
}

/** The ref only publishes the node; the component owner binds and releases its surface. */
export function createChatPickerOverlay(): (details: HTMLDetailsElement) => void {
  const [element, setElement] = createSignal<HTMLDetailsElement>();
  createEffect(element, (details) => (details ? bindChatPickerOverlay(details) : undefined));
  return (details) => setElement(details);
}

function composerPickerIsOpen(picker: HTMLElement): boolean {
  if (picker instanceof HTMLDetailsElement) {
    return picker.open;
  }
  return ("open" in picker && picker.open === true) || picker.hasAttribute("open");
}

function openChatComposerPickers(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ".agent-chat__input details, .agent-chat__input wa-dropdown",
    ),
  ).filter(composerPickerIsOpen);
}

function closeComposerPicker(picker: HTMLElement): void {
  const native = picker instanceof HTMLDetailsElement ? nativePickers.get(picker) : undefined;
  if (native) {
    native.request(false);
    return;
  }
  pointerOpenedDropdowns.delete(picker);
  picker.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
  if (picker instanceof HTMLDetailsElement) {
    picker.open = false;
  } else {
    if ("open" in picker) {
      picker.open = false;
    }
    picker.removeAttribute("open");
  }
}

function pickerTrigger(picker: HTMLElement): HTMLElement | null {
  return picker instanceof HTMLDetailsElement
    ? picker.querySelector<HTMLElement>("summary")
    : picker.querySelector<HTMLElement>("[slot=trigger]");
}

function dropdownFromEvent(event: Event): HTMLElement | undefined {
  return event
    .composedPath()
    .find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.localName === "wa-dropdown",
    );
}

function clearPointerFocus(this: HTMLElement): void {
  // Blur and keyboard takeover complete the same pointer-focus lifetime.
  this.removeEventListener("blur", clearPointerFocus);
  this.removeEventListener("keydown", clearPointerFocus);
  this.removeAttribute(POINTER_RESTORED_FOCUS_ATTRIBUTE);
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
    for (const picker of openChatComposerPickers(ownerDocument)) {
      if (!picker.hasAttribute("data-chat-native-picker") && !path.includes(picker)) {
        closeComposerPicker(picker);
      }
    }
    for (const menu of ownerDocument.querySelectorAll<HTMLElement>(LEGACY_INVOCATION_MENUS)) {
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
    if (clearChatModelSearchOnEscape(event)) {
      return;
    }
    const pickers = openChatComposerPickers(ownerDocument);
    const invocationComposer = ownerDocument
      .querySelector<HTMLElement>(LEGACY_INVOCATION_MENUS)
      ?.closest<HTMLElement>(".agent-chat__input");
    if (pickers.length === 0 && !invocationComposer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // A nested menu restores focus inside its still-open parent picker.
    const deepestPickers = pickers.filter(
      (picker) => !pickers.some((other) => other !== picker && picker.contains(other)),
    );
    const lastPicker = deepestPickers.at(-1);
    deepestPickers.forEach(closeComposerPicker);
    invocationComposer?.dispatchEvent(new CustomEvent(CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT));
    invocationComposer
      ?.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
      ?.focus({ preventScroll: true });
    if (lastPicker) {
      pickerTrigger(lastPicker)?.focus({ preventScroll: true });
    }
  }

  ownerDocument.addEventListener("pointerdown", dismissChatComposerPickersOutside, options);
  // Window capture observes the open picker before component Escape handlers
  // mutate details.open and erase the return-focus owner.
  ownerDocument.defaultView?.addEventListener(
    "keydown",
    dismissChatComposerPickersOnEscape,
    options,
  );
  ownerDocument.addEventListener(
    "keydown",
    (event) => {
      const dropdown = dropdownFromEvent(event);
      if (dropdown) {
        pointerOpenedDropdowns.delete(dropdown);
        dropdown.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
      }
    },
    options,
  );

  return () => controller.abort();
}

export function closeOtherChatComposerPickers(source: HTMLElement): void {
  const composer = source.closest(".agent-chat__input");
  if (!composer) {
    return;
  }
  for (const picker of openChatComposerPickers(composer)) {
    if (picker !== source && !picker.contains(source)) {
      closeComposerPicker(picker);
    }
  }
}

export function handleChatComposerDropdownShow(event: Event): void {
  const dropdown = event.target;
  if (dropdown instanceof HTMLElement && dropdown.localName === "wa-dropdown") {
    if (!pointerOpenedDropdowns.has(dropdown)) {
      dropdown.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
    }
    closeOtherChatComposerPickers(dropdown);
  }
}

export function markPointerOpenedChatComposerDropdown(event: PointerEvent): void {
  const dropdown = dropdownFromEvent(event);
  if (dropdown) {
    pointerOpenedDropdowns.add(dropdown);
    dropdown.setAttribute(POINTER_OPENED_PICKER_ATTRIBUTE, "");
  }
}

export function restorePointerOpenedChatComposerTrigger(event: Event): void {
  const dropdown =
    event.target instanceof HTMLElement && event.target.localName === "wa-dropdown"
      ? event.target
      : event.currentTarget;
  if (
    dropdown instanceof HTMLElement &&
    dropdown.localName === "wa-dropdown" &&
    pointerOpenedDropdowns.delete(dropdown)
  ) {
    const trigger = pickerTrigger(dropdown);
    if (!trigger) {
      return;
    }
    trigger.setAttribute(POINTER_RESTORED_FOCUS_ATTRIBUTE, "");
    trigger.addEventListener("blur", clearPointerFocus, { once: true });
    trigger.addEventListener("keydown", clearPointerFocus, { once: true });
    trigger.focus({ preventScroll: true });
  }
}
