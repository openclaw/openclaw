import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("sr-only-", { ignoreCloseErrors: true });

fixture.describe("screen-reader-only utility", () => {
  it.each([
    ["sr-only", "inset(50%)"],
    ["settings-control__sr-label", "none"],
    ["cron-required-sr", "none"],
  ])("visually hides %s while preserving its accessible status", async (className, clipPath) => {
    await withBrowserPage(fixture.page(), async (page) => {
      await page.setContent(
        styleDocument(
          readStyles("styles/base", "styles/settings-controls", "styles/cron"),
          `<span class="${className}" role="status">Background task active</span>`,
        ),
      );

      const status = page.getByRole("status");
      await expect
        .poll(async () => {
          return await status.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              borderWidth: style.borderWidth,
              clip: style.clip,
              clipPath: style.clipPath,
              height: style.height,
              margin: style.margin,
              overflow: style.overflow,
              padding: style.padding,
              position: style.position,
              whiteSpace: style.whiteSpace,
              width: style.width,
            };
          });
        })
        .toEqual({
          borderWidth: "0px",
          clip: "rect(0px, 0px, 0px, 0px)",
          clipPath,
          height: "1px",
          margin: "-1px",
          overflow: "hidden",
          padding: "0px",
          position: "absolute",
          whiteSpace: "nowrap",
          width: "1px",
        });
      expect(await status.ariaSnapshot()).toContain("Background task active");
    });
  });
});
