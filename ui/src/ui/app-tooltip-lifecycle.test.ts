/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import { clearActiveFloatingTooltips, promoteNativeTitleTooltip } from "../lib/dom-tooltips.ts";

afterEach(() => {
  clearActiveFloatingTooltips();
  document.querySelector(".control-ui-floating-tooltip")?.remove();
});

describe("OpenClawApp tooltip lifecycle", () => {
  it("clears the active floating tooltip when the app disconnects", async () => {
    const { OpenClawApp } = await import("./app.ts");
    const app = document.createElement("openclaw-app") as InstanceType<typeof OpenClawApp>;
    const button = document.createElement("button");
    button.title = "Refresh files";
    app.append(button);

    promoteNativeTitleTooltip(button, app, "pointer");
    expect(document.querySelector<HTMLElement>(".control-ui-floating-tooltip")?.dataset.open).toBe(
      "true",
    );

    app.disconnectedCallback();

    expect(button.title).toBe("Refresh files");
    expect(button.hasAttribute("data-floating-tooltip-active")).toBe(false);
    expect(document.querySelector<HTMLElement>(".control-ui-floating-tooltip")?.dataset.open).toBe(
      "false",
    );
  });
});
