import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { disposeTerminalController } from "./terminal-controller-lifecycle.ts";
import {
  forceTerminalRender,
  TERMINAL_OUTPUT_ENCODER,
  type TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";
import { terminalTheme } from "./terminal-theme.ts";

function activeElementFor(host: HTMLElement): Element | null {
  const root = host.getRootNode();
  return root instanceof ShadowRoot
    ? (root.activeElement ?? document.activeElement)
    : document.activeElement;
}

function focusIfConnected(target: Element | null): void {
  if (target instanceof HTMLElement && target.isConnected) {
    target.focus();
  }
}

/** Replays recovery output into a hidden replacement, then atomically swaps it in. */
export async function replaceTerminalController(
  target: {
    controller: GhosttyTerminalController;
    host: HTMLDivElement;
  },
  createController: (
    parent: HTMLElement,
    options?: { readOnly?: boolean },
  ) => Promise<GhosttyTerminalController>,
  replay: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }

  const previousController = target.controller;
  const previousHost = target.host;
  const previouslyFocused = activeElementFor(previousHost);
  const previousTerminalOwnedFocus = previousHost.contains(previouslyFocused);
  // SAFETY: cloneNode preserves the element type of the HTMLDivElement host.
  const replacementHost = previousHost.cloneNode() as HTMLDivElement;
  // The host is absolutely inset in the viewport. Keep it measurable while
  // hidden so Ghostty fits the authoritative replay to the real terminal grid.
  replacementHost.style.display = "block";
  replacementHost.style.visibility = "hidden";
  replacementHost.inert = true;
  previousHost.before(replacementHost);

  let replacement: GhosttyTerminalController | undefined;
  const disposeUnpublishedReplacement = () => {
    if (replacementHost.contains(activeElementFor(replacementHost))) {
      focusIfConnected(previouslyFocused);
    }
    if (replacement) {
      disposeTerminalController(replacement, replacementHost);
    } else {
      replacementHost.remove();
    }
  };
  try {
    // Ghostty autofocuses during open. Stage read-only so hidden focus can
    // never forward keyboard input before the replacement is published.
    replacement = await createController(replacementHost, { readOnly: true });
    if (signal.aborted) {
      disposeUnpublishedReplacement();
      return false;
    }
    if (replay) {
      replacement.write(TERMINAL_OUTPUT_ENCODER.encode(replay));
    }
    // ghostty-web 0.4.0 focuses during open and again in a zero-delay task.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (signal.aborted) {
      disposeUnpublishedReplacement();
      return false;
    }
  } catch (error) {
    disposeUnpublishedReplacement();
    throw error;
  }

  const currentlyFocused = activeElementFor(previousHost);
  let focusTarget: Element | null = null;
  if (previousHost.contains(currentlyFocused)) {
    focusTarget = replacementHost;
  } else if (replacementHost.contains(currentlyFocused)) {
    focusTarget = previousTerminalOwnedFocus ? replacementHost : previouslyFocused;
  }
  replacementHost.inert = false;
  replacement.setReadOnly(previousController.readOnly);
  replacementHost.style.display = previousHost.style.display;
  replacementHost.style.visibility = previousHost.style.visibility;
  target.controller = replacement;
  target.host = replacementHost;
  disposeTerminalController(previousController, previousHost);
  focusIfConnected(focusTarget);
  return true;
}

export function repaintTerminalSession(tab: TerminalPanelSessionTab | undefined): void {
  if (tab) {
    tab.controller.fit();
    forceTerminalRender(tab.controller);
  }
}

export async function focusTerminalSession(
  tab: TerminalPanelSessionTab | undefined,
  rendered: Promise<unknown>,
  focus = true,
): Promise<void> {
  // Refit and repaint after the container becomes visible. A same-size tab
  // switch otherwise leaves the newly shown canvas without dirty rows.
  await rendered;
  repaintTerminalSession(tab);
  if (tab && focus) {
    tab.controller.terminal.focus();
  }
}

export function updateTerminalSessionTheme(
  tabs: readonly TerminalPanelSessionTab[],
  themeMode: "dark" | "light",
): void {
  // Unopened panels still observe theme changes; resolve colors only for live renderers.
  let theme: ReturnType<typeof terminalTheme> | undefined;
  for (const tab of tabs) {
    // ghostty-web 0.4.0 ignores options.theme after open() (its option
    // handler only warns), so update the renderer directly and force one
    // full render — the frame loop repaints only dirty rows, which would
    // leave a static screen on the old palette.
    const term = tab.controller.terminal;
    if (term.renderer && term.wasmTerm) {
      term.renderer.setTheme((theme ??= terminalTheme(themeMode)));
      forceTerminalRender(tab.controller);
    }
  }
}

export function reattachTerminalSessionHosts(
  tabs: readonly TerminalPanelSessionTab[],
  activeId: string | null,
  viewport: Element | null,
): void {
  if (!viewport) {
    return;
  }
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const activeHostDetached = activeTab?.host.parentElement !== viewport;
  // Hiding the panel removes its viewport, which detaches each session's Ghostty
  // host. Re-attach live hosts whenever the viewport is rendered so a
  // hide/show cycle keeps the terminals intact instead of blanking them.
  for (const tab of tabs) {
    if (tab.host.parentElement !== viewport) {
      viewport.append(tab.host);
    }
  }
  if (activeTab && activeHostDetached) {
    // ResizeObserver owns attached geometry; ordinary panel publications need no layout read.
    activeTab.controller.fit();
    // FitAddon skips unchanged dimensions; force dirty-row rendering to
    // repair a canvas that was detached while the panel was hidden.
    forceTerminalRender(activeTab.controller);
  }
}
