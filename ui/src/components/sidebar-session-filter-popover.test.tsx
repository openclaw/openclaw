/* @vitest-environment jsdom */

import { expect, it, onTestFinished } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";

it.each([false, true])(
  "places initial focus without overriding a chosen control (%s)",
  async (chosen) => {
    const container = document.createElement("div");
    const anchor = document.createElement("button");
    document.body.append(container);
    container.append(anchor);
    onTestFinished(() => container.remove());
    if (chosen) {
      container.addEventListener(
        "toggle",
        () => {
          container
            .querySelector<HTMLButtonElement>(".sidebar-session-filter-panel button")
            ?.focus();
        },
        { once: true, capture: true },
      );
    }
    mountSolid(
      () => (
        <SidebarSessionFilterPopover
          anchor={anchor}
          content={
            <>
              <div id="sidebar-sessions-status">
                <input type="radio" checked />
              </div>
              <button>Sort</button>
            </>
          }
        />
      ),
      { container },
    );
    await waitForSolid(() => expect(container.querySelector("input")).not.toBeNull());
    const initial = container.querySelector("input")!;
    const control = container.querySelector<HTMLButtonElement>(
      "openclaw-sidebar-session-filter-popover button",
    )!;
    await waitForSolid(() => expect(document.activeElement).toBe(chosen ? control : initial));
    control.focus();
    container
      .querySelector(".sidebar-session-filter-panel")!
      .dispatchEvent(new CustomEvent("overlay-after-show"));
    expect(document.activeElement).toBe(control);
  },
);
