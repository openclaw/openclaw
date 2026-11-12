import { isSessionRouteId } from "../app-route-paths.ts";
import { activeElement } from "../components/focus-navigation.ts";
import {
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-contract.ts";
import type { ShellChromeHost } from "./app-shell-chrome.ts";

export class ShellSessionShortcuts {
  private claimedKey: string | null = null;

  constructor(
    private readonly host: ShellChromeHost,
    private readonly shouldIgnore: (event: KeyboardEvent) => boolean,
  ) {}

  readonly release = (): void => {
    this.claimedKey = null;
  };

  handleKeydown(event: KeyboardEvent): boolean {
    const previous = matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.previousSession, event);
    if (!previous && !matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.nextSession, event)) {
      return false;
    }
    // Selection can autofocus the new composer. Keep a held chord from falling
    // through to browser history, even after focus or the route changes.
    if (event.repeat && this.claimedKey === event.key) {
      event.preventDefault();
      return true;
    }
    const host = this.host;
    if (
      !event.defaultPrevented &&
      !event.repeat &&
      !host.onboardingMode &&
      isSessionRouteId(host.routeState.routeId) &&
      !this.shouldIgnore(event) &&
      host.element.contains(host.navigationSidebar) &&
      host.navigationSidebar.selectAdjacentSession?.(previous ? -1 : 1)
    ) {
      this.claimedKey = event.key;
      event.preventDefault();
    }
    return true;
  }

  dispatchNative(key: "[" | "]"): void {
    // AppKit consumes menu equivalents before WebKit delivers keydown. Re-enter
    // through the focused control so the normal editable and overlay guards apply.
    const target = activeElement(this.host.element);
    // Ordinary keydown never crosses a browsing-context boundary either.
    if (target instanceof HTMLIFrameElement) {
      return;
    }
    (target ?? document).dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        metaKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
  }
}
