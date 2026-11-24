import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("page-toolbar-rhythm-", { ignoreCloseErrors: true });

// Header action buttons share the control height of the refresh icon beside them.
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

const markup = `<main class="content content--logs-page"><section class="content-header content-header--settings">
  <div class="page-header-actions"><button class="oc-icon-button oc-icon-button--32 refresh-button" type="button"></button><button class="btn" type="button">Export visible</button></div>
</section></main>
<div class="transcripts-actions"><a class="btn" href="#">Meeting capture</a><button class="oc-icon-button oc-icon-button--32 refresh-button" type="button"></button></div>
<div class="dashboards-tools"><button class="oc-icon-button oc-icon-button--32 dashboards-tools__trigger" type="button"></button><label class="dashboards-search"><span class="dashboards-search__icon"></span><input class="header-search__input" type="search" /></label></div>`;

const HEADER_ACTIONS = ".page-header-actions > *, .transcripts-actions > *";

fixture.describe("page toolbar control height", () => {
  // Dashboards keeps 32px at every width; the header buttons follow the touch height.
  it.each([
    ["desktop", 1280, `${HEADER_ACTIONS}, .dashboards-tools > *`, [32, 32, 32, 32, 32, 32]],
    ["phone", 600, HEADER_ACTIONS, [38, 38, 38, 38]],
  ])("%s header actions share one height", async (name, width, selectors, expected) => {
    const actual = await fixture.withPage(name, styleDocument(css, markup), async (page) => {
      await page.setViewportSize({ width, height: 800 });
      return page.evaluate(
        (query) =>
          [...document.querySelectorAll(query)].map((el) => el.getBoundingClientRect().height),
        selectors,
      );
    });
    expect(actual).toEqual(expected);
  });
});
