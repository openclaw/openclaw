import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("page-toolbar-rhythm-", { ignoreCloseErrors: true });

// Page toolbars put labeled buttons, icon buttons and fields on one control height.
const css = readStyles(
  "styles/base",
  "styles/components",
  "components/solid/icon-button",
  "styles/settings-controls",
  "styles/layout",
  "styles/dashboards",
  "styles/logs",
  "pages/meetings/meetings",
);

const markup = `<main class="content content--logs-page">
  <section class="content-header content-header--settings">
    <div class="page-header-actions">
      <button class="oc-icon-button oc-icon-button--32 refresh-button" type="button" aria-label="Refresh"></button>
      <button class="btn logs-export" type="button">Export visible</button>
    </div>
  </section>
</main>
<div class="transcripts-actions">
  <a class="btn meetings-capture" href="#">Meeting capture</a>
  <button class="oc-icon-button oc-icon-button--32 refresh-button" type="button" aria-label="Refresh"></button>
</div>
<div class="dashboards-tools">
  <span class="dashboards-search-toggle"><button class="oc-icon-button oc-icon-button--32 dashboards-search-button" type="button" aria-label="Search"></button></span>
  <button class="oc-icon-button oc-icon-button--32 dashboards-tools__trigger" type="button" aria-label="Filter"></button>
  <button class="oc-icon-button oc-icon-button--32 dashboards-display__trigger" type="button" aria-label="Display"></button>
  <label class="dashboards-search"><span class="dashboards-search__icon"></span><input class="header-search__input" type="search" /></label>
</div>`;

const CONTROLS = [
  ".logs-export",
  ".meetings-capture",
  ".dashboards-search-button",
  ".dashboards-tools__trigger",
  ".dashboards-display__trigger",
  ".dashboards-search",
  ".dashboards-search__icon",
];

const heights = (page: Parameters<Parameters<typeof fixture.withPage>[2]>[0]) =>
  page.evaluate(
    (selectors) =>
      selectors.map((selector) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        return selector === ".dashboards-search__icon" ? box.width : box.height;
      }),
    CONTROLS,
  );

fixture.describe("page toolbar control height", () => {
  it.each([
    ["desktop", { width: 1280, height: 800 }, 32],
    ["phone", { width: 600, height: 800 }, 38],
  ])("%s header actions share the control height", async (name, viewport, expected) => {
    const actual = await fixture.withPage(name, styleDocument(css, markup), async (page) => {
      await page.setViewportSize(viewport);
      return heights(page);
    });
    expect(actual).toEqual(CONTROLS.map(() => expected));
  });
});
