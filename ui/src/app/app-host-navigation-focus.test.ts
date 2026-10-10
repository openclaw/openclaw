/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";

afterEach(resetAppHostTestGlobals);

describe("navigation drawer focus ownership", () => {
  it.each([false, true])("restores drawer focus only when it was open (%s)", (open) => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const shell = createShellOwner();
    document.body.append(shell.element);
    const content = shell.element.appendChild(document.createElement("main"));
    content.className = "content";
    content.tabIndex = -1;
    const trigger = shell.element.appendChild(document.createElement("button"));
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
      shell.element.remove();
    }
  });
});
