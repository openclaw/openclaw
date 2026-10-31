import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { renderPluginDetailShell } from "./detail-shell.tsx";
import { PluginRecommendedPrompts } from "./recommended-prompts.tsx";
import baseStyles from "../../styles/base.css?inline";
import componentStyles from "../../styles/components.css?inline";
import pluginStyles from "../../styles/plugins.css?inline";

let container: HTMLDivElement;
let styles: HTMLStyleElement;

beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = [baseStyles, componentStyles, pluginStyles].join("\n");
  document.head.append(styles);
  container = document.createElement("div");
  container.style.cssText =
    "box-sizing:border-box;width:min(1100px,100%);padding:16px;--primary:#f5654a";
  document.body.append(container);
});
afterEach(() => {
  cleanupSolid();
  container.remove();
  styles.remove();
});

function renderDetail(sidebar: boolean) {
  mountSolid(
    () =>
      renderPluginDetailShell({
        id: "calendar-plus",
        name: "Calendar Plus",
        summary: "Plan and coordinate work from a shared calendar.",
        identity: undefined,
        backHref: "/plugins",
        backLabel: "Plugins",
        onBack: vi.fn(),
        titleAction: <button type="button">Install</button>,
        recommendations: (
          <PluginRecommendedPrompts
            id="calendar-plus"
            name="Calendar Plus"
            prompts={[
              "Help me get started.",
              "Find time for a project review.",
              "Summarize tomorrow's meetings and preparation notes.",
            ]}
            onSelect={vi.fn()}
          />
        ),
        panel: <p>Plugin capabilities</p>,
        sidebar: sidebar ? (
          <div>
            Downloads
            <br />
            52.2k
            <hr />
            Categories
            <br />
            Calendar
          </div>
        ) : undefined,
      }),
    { container },
  );
}

function geometry() {
  const panel = container.querySelector<HTMLElement>(".plugin-recommended-prompts")!;
  const main = container.querySelector<HTMLElement>(".plugin-catalog-detail__main")!;
  const content = container.querySelector<HTMLElement>(".plugin-catalog-detail__content")!;
  const hero = container.querySelector<HTMLElement>(".plugin-catalog-detail__hero")!;
  const sidebar = container.querySelector<HTMLElement>(".plugin-catalog-detail__sidebar");
  return { panel, main, content, hero, sidebar };
}

it.each([1440, 1366, 768, 390])(
  "keeps recommendations in the main column with a right rail at %i px",
  async (width) => {
    await page.viewport(width, 900);
    renderDetail(true);
    const { panel, main, content, hero, sidebar } = geometry();
    await expect.poll(() => main.contains(panel)).toBe(true);
    await expect
      .poll(() =>
        Math.abs(panel.getBoundingClientRect().width - main.getBoundingClientRect().width),
      )
      .toBeLessThanOrEqual(1);
    expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      hero.getBoundingClientRect().bottom,
    );
    const columns = getComputedStyle(content).gridTemplateColumns.split(/\s+/u);
    if (columns.length === 2) {
      expect(panel.getBoundingClientRect().right).toBeLessThanOrEqual(
        sidebar!.getBoundingClientRect().left -
          Number.parseFloat(getComputedStyle(content).columnGap) +
          1,
      );
      expect(sidebar!.getBoundingClientRect().top).toBeLessThanOrEqual(
        panel.getBoundingClientRect().top + 1,
      );
    } else {
      expect(sidebar!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        main.getBoundingClientRect().bottom,
      );
    }
    expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
    for (const row of panel.querySelectorAll<HTMLElement>("button")) {
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    }
  },
);

it("fills the main column without reserving an absent metadata rail", async () => {
  await page.viewport(1440, 900);
  renderDetail(false);
  const { panel, main, content, sidebar } = geometry();
  expect(sidebar).toBeNull();
  await expect.poll(() => main.contains(panel)).toBe(true);
  await expect
    .poll(() =>
      Math.abs(panel.getBoundingClientRect().width - content.getBoundingClientRect().width),
    )
    .toBeLessThanOrEqual(1);
});
