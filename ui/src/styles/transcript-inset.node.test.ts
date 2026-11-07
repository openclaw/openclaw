import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("transcript-inset-");

fixture.describe("transcript reading inset before composer loading", () => {
  it("resolves inherited lengths to pixels and supplies the empty inset", async () => {
    await withBrowserPage(fixture.page(), async (page) => {
      await page.setContent(
        styleDocument(
          readStyles("styles/base"),
          `<div style="font-size: 20px; --chat-thread-inline-inset: calc(1em + 6px)">
            <div id="inherited" style="font-size: 10px"></div>
          </div><div id="empty"></div>`,
        ),
      );
      expect(
        await page.evaluate(() =>
          ["inherited", "empty"].map((id) =>
            getComputedStyle(document.getElementById(id)!).getPropertyValue(
              "--chat-thread-inline-inset",
            ),
          ),
        ),
      ).toEqual(["26px", "0px"]);
    });
  });
});
