import type { Tab } from "./navigation.ts";

export type DashboardShortcutAction =
  | "toggle-palette"
  | "focus-composer"
  | "scroll-new-messages"
  | "dismiss-transient";

export type DashboardShortcutState = {
  tab: Tab;
  paletteOpen: boolean;
  chatNewMessagesBelow: boolean;
  chatManualRefreshInFlight: boolean;
  chatMobileControlsOpen: boolean;
  chatSessionPickerOpen: boolean;
  navDrawerOpen: boolean;
  sessionSwitchNoticeActive: boolean;
  sidebarOpen: boolean;
  onboarding: boolean;
};

const TEXT_ENTRY_SELECTOR = [
  "input",
  "textarea",
  "select",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='textbox']",
  ".cm-editor",
  ".monaco-editor",
].join(",");

function isTextEntryElement(target: EventTarget | null): boolean {
  if (target === null || typeof (target as Element).closest !== "function") {
    return false;
  }
  const element = target as Element;
  const isContentEditable = "isContentEditable" in element && Boolean(element.isContentEditable);
  return isContentEditable || Boolean(element.closest(TEXT_ENTRY_SELECTOR));
}

export function isDashboardShortcutTextEntryEvent(event: KeyboardEvent): boolean {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.some((target) => isTextEntryElement(target))) {
    return true;
  }
  return isTextEntryElement(document.activeElement);
}

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function hasPrintableShortcutModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

export function resolveDashboardShortcutAction(
  event: KeyboardEvent,
  state: DashboardShortcutState,
): DashboardShortcutAction | null {
  if (hasCommandModifier(event) && !event.shiftKey && event.key.toLowerCase() === "k") {
    return "toggle-palette";
  }

  if (isDashboardShortcutTextEntryEvent(event)) {
    return null;
  }

  if (!hasPrintableShortcutModifier(event) && event.key === "/") {
    return "focus-composer";
  }

  if (
    !hasPrintableShortcutModifier(event) &&
    event.key.toLowerCase() === "n" &&
    state.tab === "chat" &&
    state.chatNewMessagesBelow &&
    !state.chatManualRefreshInFlight
  ) {
    return "scroll-new-messages";
  }

  if (
    !hasPrintableShortcutModifier(event) &&
    event.key === "Escape" &&
    (state.paletteOpen ||
      state.chatSessionPickerOpen ||
      state.chatMobileControlsOpen ||
      state.navDrawerOpen ||
      state.sessionSwitchNoticeActive ||
      state.sidebarOpen)
  ) {
    return "dismiss-transient";
  }

  return null;
}
