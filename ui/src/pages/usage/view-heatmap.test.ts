import { afterEach, describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { dailyEntry } from "./usage-chart.test-support.ts";
import { renderUsageHeatmap } from "./view-heatmap.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

describe("renderUsageHeatmap", () => {
  it("renders the selected activity range from usage cost data", () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        renderUsageHeatmap(
          [dailyEntry("2026-07-08", 10), dailyEntry("2026-07-09", 20)],
          "2025-07-11",
          "2026-07-09",
        ),
      { container },
    );
    flush();

    expect(container.querySelector(".settings-section__heading")?.textContent?.trim()).toBe(
      "Token Activity",
    );
    expect(container.querySelectorAll(".usage-heatmap__cell")).toHaveLength(52 * 7);
    expect(
      container
        .querySelector(".usage-heatmap__svg .usage-heatmap__cell--l4")
        ?.getAttribute("data-tooltip"),
    ).toContain("20 tokens");
  });

  it("keeps short ranges at their natural cell width", () => {
    const container = document.createElement("div");
    mountSolid(
      () => renderUsageHeatmap([dailyEntry("2026-08-01", 20)], "2026-08-01", "2026-08-01"),
      { container },
    );
    flush();

    expect(
      container
        .querySelector<SVGElement>(".usage-heatmap__svg")
        ?.style.getPropertyValue("--usage-heatmap-width"),
    ).toBe("44px");
  });
});
