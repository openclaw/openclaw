import type { Locator } from "playwright";
import { expect } from "vitest";

export async function expectPaletteProjectGrouping(popup: Locator) {
  const groups = await popup
    .locator(".palette-session-settings__choices > section")
    .evaluateAll((sections) =>
      sections.map((section) => {
        const heading = section.querySelector(".palette-session-settings__machine");
        const labels = section.querySelectorAll(".palette-session-settings__label");
        const firstLabel = labels[0];
        const lastLabel = labels[labels.length - 1];
        if (!heading || !firstLabel || !lastLabel) {
          throw new Error("Missing project group content");
        }
        const range = document.createRange();
        range.selectNodeContents(heading);
        const title = range.getBoundingClientRect();
        return {
          top: title.top,
          bottom: lastLabel.getBoundingClientRect().bottom,
          headingGap: firstLabel.getBoundingClientRect().top - title.bottom,
        };
      }),
    );
  expect(groups.length).toBeGreaterThan(1);
  let previous: (typeof groups)[number] | undefined;
  for (const current of groups) {
    if (previous) {
      expect.soft(current.top - previous.bottom).toBeGreaterThan(current.headingGap * 2);
    }
    previous = current;
  }
}
