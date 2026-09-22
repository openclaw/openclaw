import type { Locator } from "playwright";
import { expect } from "vitest";

export async function expectPaletteSettingsAlignment(popup: Locator) {
  const box = async (selector: string) => {
    const bounds = await popup.locator(selector).boundingBox();
    if (!bounds) {
      throw new Error("Missing settings control: " + selector);
    }
    return bounds;
  };
  const avatar = await box(".agent-select__trigger .agent-select__avatar");
  const folder = await box(
    ".palette-session-settings__workspace .palette-session-settings__icon svg",
  );
  const agentChevron = await box(".agent-select__chevron svg");
  const workspaceChevron = await box(".palette-session-settings__chevron svg");
  const agentLabel = await box(".agent-select__label");
  const workspaceLabel = await box(
    ".palette-session-settings__workspace .palette-session-settings__label",
  );
  const typography = (selector: string) =>
    popup.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.fontSize, style.fontWeight, style.lineHeight, style.fontFamily];
    });
  expect
    .soft(await typography(".agent-select__label"))
    .toEqual(
      await typography(".palette-session-settings__workspace .palette-session-settings__label"),
    );
  expect.soft(avatar.width).toBe(folder.width + 2);
  expect.soft(avatar.x + avatar.width / 2).toBeCloseTo(folder.x + folder.width / 2, 0);
  expect.soft(agentChevron.x).toBeCloseTo(workspaceChevron.x, 0);
  expect.soft(agentLabel.x).toBeCloseTo(workspaceLabel.x, 0);
  expect
    .soft(avatar.y + avatar.height / 2)
    .toBeCloseTo(agentChevron.y + agentChevron.height / 2, 0);
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
