import { expect, it } from "vitest";
import { withBrowserPage } from "../test-helpers/browser-page.ts";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("reduced-motion-");

fixture.describe("Reduced motion transitions", () => {
  it("leaves static content without transitions and preserves authored motion reductions", async () => {
    await withBrowserPage(fixture.page({ reducedMotion: "reduce" }), async (page) => {
      await page.setContent(
        styleDocument(
          readStyles("styles/base", "styles/layout", "styles/chat/layout"),
          '<div id="static">Static content</div><div class="shell"></div><button class="chat-scroll-to-bottom">Latest</button>',
        ),
      );
      const styles = await page.evaluate(() => {
        const read = (selector: string, pseudo?: string) => {
          const style = getComputedStyle(document.querySelector(selector)!, pseudo);
          return {
            property: style.transitionProperty,
            duration: style.transitionDuration,
            delay: style.transitionDelay,
          };
        };
        return {
          static: [read("#static"), read("#static", "::before"), read("#static", "::after")],
          shell: read(".shell"),
          latest: read(".chat-scroll-to-bottom"),
          shortDuration: `${Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--duration-fast")) / 1_000}s`,
        };
      });
      for (const style of styles.static) {
        expect(style).toEqual({ property: "none", duration: "0s", delay: "0s" });
      }
      expect(styles.shell).toEqual({
        property: "grid-template-columns, grid-template-rows",
        duration: "0s",
        delay: "0s, 0s",
      });
      expect(styles.latest).toEqual({
        property: "opacity, visibility",
        duration: `${styles.shortDuration}, 0s`,
        delay: `0s, ${styles.shortDuration}`,
      });
    });
  });
});
