import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("background-invalidation-", { required: true });

fixture.describe("personal background style scope", () => {
  it("updates chat surfaces without restyling the unchanged sidebar", async () => {
    await fixture.withPage(
      "background",
      styleDocument(
        readStyles(
          "styles/base",
          "styles/layout",
          "styles/chat/grouped",
          "styles/chat/composer-surface",
        ),
        `<div class="shell shell--chat"><aside>
          ${Array.from({ length: 64 }, (_, index) => `<div class="sidebar-recent-session"><a>Session ${index}</a><span>Ready</span></div>`).join("")}
          </aside><main><div class="chat-group user"><div class="chat-bubble">Hello</div></div>
          <div class="agent-chat__input">Composer</div></main></div>`,
      ),
      async (page) => {
        const backgrounds = () =>
          page.evaluate(() =>
            [".chat-bubble", ".agent-chat__input"].map(
              (selector) => getComputedStyle(document.querySelector(selector)!).backgroundImage,
            ),
          );
        expect(await backgrounds()).toEqual(["none", "none"]);
        const cdp = await page.context().newCDPSession(page);
        const recalculated: number[] = [];
        cdp.on("Tracing.dataCollected", ({ value }) => {
          for (const event of value) {
            const args = event.args;
            if (
              event.name === "UpdateLayoutTree" &&
              isRecord(args) &&
              typeof args.elementCount === "number"
            ) {
              recalculated.push(args.elementCount);
            }
          }
        });
        await cdp.send("Tracing.start", {
          categories: "devtools.timeline",
          transferMode: "ReportEvents",
        });
        await page.locator(".shell").evaluate((shell) => {
          shell.setAttribute("data-background-managed", "");
        });
        const painted = await backgrounds();
        const completed = new Promise<void>((resolve) => {
          cdp.once("Tracing.tracingComplete", () => resolve());
        });
        await cdp.send("Tracing.end");
        await completed;
        await cdp.detach();
        expect(painted.every((background) => background.startsWith("linear-gradient("))).toBe(true);
        expect(recalculated.length).toBeGreaterThan(0);
        // Fewer computations than sidebar rows excludes a sidebar-wide invalidation.
        expect(recalculated.reduce((total, count) => total + count, 0)).toBeLessThan(64);
      },
    );
  });
});
