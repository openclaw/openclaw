/* @vitest-environment jsdom */

import { html, render, type LitElement } from "lit";
import { expect, it } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import "./sidebar-session-filter-popover.ts";

it.each([false, true])(
  "places initial focus without overriding a chosen control (%s)",
  async (chosen) => {
    const container = document.createElement("div");
    const anchor = document.createElement("button");
    document.body.append(container);
    container.append(anchor);
    const holdReposition = (event: Event) => event.stopImmediatePropagation();
    container.addEventListener("wa-reposition", holdReposition, true);
    render(
      html`<openclaw-sidebar-session-filter-popover
        .anchor=${anchor}
        .content=${html`<div id="sidebar-sessions-status"><input type="radio" checked /></div>
          <button>Sort</button>`}
      ></openclaw-sidebar-session-filter-popover>`,
      container,
    );
    await container.querySelector<LitElement>("openclaw-sidebar-session-filter-popover")!
      .updateComplete;
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
