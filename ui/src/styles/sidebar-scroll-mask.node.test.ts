import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { readStyles, styleDocument, styleFixture } from "./style-fixture.test-support.ts";

const fixture = styleFixture("sidebar-scroll-mask-");

fixture.describe("sidebar scroll mask", () => {
  it("changes scroll fades without restyling the session rows", async () => {
    await fixture.withPage(
      "scroll-state",
      styleDocument(
        readStyles("styles/base", "styles/layout"),
        `<div class="sidebar-shell__body sidebar-shell__body--scroll-top" style="height:100px;width:200px;flex:none">
          ${Array.from({ length: 64 }, (_, index) => `<div>Session ${index}</div>`).join("")}
        </div>`,
      ),
      async (page) => {
        await page.locator(".sidebar-shell__body").evaluate((scroller) => {
          return getComputedStyle(scroller).maskImage;
        });
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
        await page.locator(".sidebar-shell__body").evaluate((scroller) => {
          scroller.classList.replace(
            "sidebar-shell__body--scroll-top",
            "sidebar-shell__body--scroll-middle",
          );
          return getComputedStyle(scroller).maskImage;
        });
        const completed = new Promise<void>((resolve) => {
          cdp.once("Tracing.tracingComplete", () => resolve());
        });
        await cdp.send("Tracing.end");
        await completed;
        await cdp.detach();
        // Only the scroller and its pseudo-element change; its 64 session rows do not.
        expect(recalculated).toHaveLength(1);
        expect(recalculated[0]).toBeLessThanOrEqual(2);
      },
    );
  });
});
