/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./demo-status-widget.ts";

let container: HTMLDivElement;

describe("openclaw-demo-status-widget", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
  });

  it("renders the static system states with distinct treatments", async () => {
    render(html`<openclaw-demo-status-widget></openclaw-demo-status-widget>`, container);
    await Promise.resolve();

    const widget = container.querySelector("openclaw-demo-status-widget");
    if (!widget) {
      throw new Error("Expected demo status widget");
    }
    await widget.updateComplete;

    expect(widget?.getAttribute("aria-label")).toBe("System Status");
    expect(widget?.querySelector(".demo-status-widget__title")?.textContent?.trim()).toBe(
      "System Status",
    );

    const states = Array.from(widget?.querySelectorAll(".demo-status-widget__state") ?? []).map(
      (state) => ({
        label: state.querySelector(".demo-status-widget__label")?.textContent?.trim(),
        detail: state.querySelector(".demo-status-widget__detail")?.textContent?.trim(),
        className: state.className,
      }),
    );

    expect(states).toEqual([
      {
        label: "Online",
        detail: "Gateway reachable",
        className: "demo-status-widget__state demo-status-widget__state--online",
      },
      {
        label: "Syncing",
        detail: "Static demo refresh",
        className: "demo-status-widget__state demo-status-widget__state--syncing",
      },
      {
        label: "Paused",
        detail: "Automation idle",
        className: "demo-status-widget__state demo-status-widget__state--paused",
      },
    ]);
  });
});
