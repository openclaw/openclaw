/* @vitest-environment jsdom */

import { expect, it } from "vitest";
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
    const holdReposition = (event: Event) => event.stopImmediatePropagation();
    container.addEventListener("wa-reposition", holdReposition, true);
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
    if (chosen) {
      control.focus();
    }
    container.removeEventListener("wa-reposition", holdReposition, true);
    container.querySelector("wa-popup")!.dispatchEvent(new CustomEvent("wa-reposition"));
    expect(document.activeElement).toBe(chosen ? control : initial);
  },
);
