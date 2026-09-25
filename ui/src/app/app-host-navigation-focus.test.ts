/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import "./app-host.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";

type ShellFocusState = HTMLElement & {
  navDrawerOpen: boolean;
  navDrawerTrigger: HTMLElement | null;
  closeNavDrawer(options?: { restoreFocus?: boolean }): void;
};

afterEach(resetAppHostTestGlobals);

describe("navigation drawer focus ownership", () => {
  it.each([false, true])("restores drawer focus only when it was open (%s)", (open) => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const shell = document.body.appendChild(
      document.createElement("openclaw-app-shell") as ShellFocusState,
    );
    const content = shell.appendChild(document.createElement("main"));
    content.className = "content";
    content.tabIndex = -1;
    const trigger = shell.appendChild(document.createElement("button"));
    Object.defineProperty(trigger, "checkVisibility", { value: () => true });
    const composer = content.appendChild(document.createElement("textarea"));
    composer.focus();
    shell.navDrawerOpen = open;
    shell.navDrawerTrigger = open ? trigger : null;
    try {
      shell.closeNavDrawer({ restoreFocus: true });
      for (const frame of frames) {
        frame(0);
      }
      expect(document.activeElement).toBe(open ? trigger : composer);
    } finally {
      shell.remove();
    }
  });
});
