import type { Locator } from "playwright";
import { expect } from "vitest";

/** Agent, folder, and worktree are one chip family on one centerline. */
export async function expectPaletteChipsAligned(palette: Locator) {
  const chips = await palette
    .locator(
      ".agent-chat__composer-controls :is(.agent-select__trigger, .palette-session-settings__chip)",
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { center: bounds.top + bounds.height / 2, height: bounds.height };
      }),
    );
  expect(chips.length).toBeGreaterThanOrEqual(2);
  for (const chip of chips) {
    expect.soft(chip.center).toBeCloseTo(chips[0]!.center, 0);
    expect.soft(chip.height).toBe(chips[0]!.height);
  }
}

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
