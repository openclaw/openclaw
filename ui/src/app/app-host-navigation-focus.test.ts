/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectedShellOwner as createShellOwner } from "./app-host-solid.test-support.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import { handleNavDrawerKeydown, navDrawerFocusableElements } from "./navigation-surface.ts";

afterEach(resetAppHostTestGlobals);

describe("navigation drawer focus ownership", () => {
  it.each([
    { open: false, via: "direct" },
    { open: true, via: "direct" },
    { open: true, via: "shortcut" },
  ])("restores drawer focus only when it was open ($open, $via)", ({ open, via }) => {
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
      if (via === "shortcut") {
        vi.stubGlobal("matchMedia", () => ({ matches: true }));
        const mac = navigator.platform.startsWith("Mac");
        composer.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "b",
            code: "KeyB",
            ctrlKey: !mac,
            metaKey: mac,
            bubbles: true,
            cancelable: true,
          }),
        );
      } else {
        shell.closeNavDrawer({ restoreFocus: true });
      }
      for (const frame of frames) {
        frame(0);
      }
      expect(document.activeElement).toBe(open ? trigger : composer);
    } finally {
      shell.element.remove();
    }
  });

  it("wraps Tab across composed drawer controls using the modal focus order", () => {
    const drawer = document.createElement("nav");
    drawer.tabIndex = -1;
    const inert = document.createElement("div");
    inert.setAttribute("inert", "");
    const inertButton = inert.appendChild(document.createElement("button"));
    const skipped = document.createElement("button");
    skipped.tabIndex = -2;
    const first = document.createElement("button");
    const control = document.createElement("div");
    const shadow = control.attachShadow({ mode: "open" });
    const last = shadow.appendChild(document.createElement("button"));
    for (const button of [inertButton, skipped, first, last]) {
      Object.defineProperty(button, "checkVisibility", { value: () => true });
    }
    drawer.append(inert, skipped, first, control);
    const host = { navDrawerElement: drawer, closeNavDrawer: vi.fn() };
    drawer.addEventListener("keydown", (event) => handleNavDrawerKeydown(host, event));
    document.body.append(drawer);
    try {
      expect(navDrawerFocusableElements(drawer)).toEqual([first, last]);
      last.focus();
      const forward = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      last.dispatchEvent(forward);
      expect(forward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);

      const reverse = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      first.dispatchEvent(reverse);
      expect(reverse.defaultPrevented).toBe(true);
      expect(shadow.activeElement).toBe(last);
    } finally {
      drawer.remove();
    }
  });
});
