import { webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let webkitBrowser: Browser;
const suite = createControlUiE2eSuite({
  name: "Logs wheel reachability",
  resources: {
    async run() {
      webkitBrowser = await webkit.launch({ headless: true });
    },
    async close() {
      await webkitBrowser?.close();
    },
  },
});

function tail(start: number, count: number) {
  return {
    file: "/synthetic/gateway.log",
    cursor: start + count,
    lines: Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return JSON.stringify({
        time: new Date(1_800_000_000_000 + index * 10).toISOString(),
        level: ["info", "info", "info", "warn", "error"][index % 5],
        subsystem: `data-lane-${index % 20}`,
        message: `Data log ${String(index).padStart(6, "0")} ${index % 100 === 0 ? "needle" : "routine"}: synthetic structured detail for stream profiling.`,
      });
    }),
  };
}

suite.define(() => {
  it.each([
    { engine: "chromium", width: 390, height: 844, action: "wheel" },
    { engine: "webkit", width: 1440, height: 1000, action: "wheel" },
    { engine: "webkit", width: 390, height: 844, action: "refresh" },
  ] as const)(
    "keeps the newest log reachable after $action in $engine ($width px)",
    async ({ engine, width, height, action }) => {
      const options = {
        viewport: { width, height },
        isMobile: width < 600,
        hasTouch: width < 600,
        serviceWorkers: "block" as const,
      };
      const context =
        engine === "chromium"
          ? await suite.newBrowserContext(options)
          : await webkitBrowser.newContext(options);
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "logs.tail": {
              sequence: [0, 500, 1_000, 1_500, 2_000].map((start) =>
                tail(start, start === 2_000 ? 0 : 500),
              ),
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}logs`);
        await page
          .getByText(/Data log 001999 routine:/)
          .waitFor()
          .catch(async (cause: unknown) => {
            const state = await page.locator(".log-stream").evaluate((element) => ({
              top: element.scrollTop,
              height: element.scrollHeight,
              viewport: element.clientHeight,
              first: element.querySelector(".log-row")?.textContent,
              last: element.querySelector(".log-row:last-child")?.textContent,
              retained: element.querySelector(".log-row")?.getAttribute("aria-setsize"),
            }));
            throw new Error(
              `Initial log window: ${JSON.stringify({ state, errors, reads: (await gateway.getRequests("logs.tail")).length })}`,
              { cause },
            );
          });
        const stream = page.getByRole("region", { name: "Logs", exact: true });
        await stream.scrollIntoViewIfNeeded();
        if (action === "refresh") {
          await gateway.setMethodResponse("logs.tail", tail(10_000, 500));
          await page.getByRole("button", { name: "Refresh", exact: true }).click();
          await page.getByText(/Data log 010499 routine:/).waitFor();
          await stream.scrollIntoViewIfNeeded();
          await expect
            .poll(() => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
            .toBeLessThan(2);
          expect(errors).toEqual([]);
          return;
        }
        await page.getByRole("switch", { name: "Auto-follow", exact: true }).uncheck();
        await gateway.setMethodResponse("logs.tail", tail(2_000, 0));
        const after = await gateway.deferNext("logs.tail");
        await gateway.waitForRequest("logs.tail", { after });
        await stream.hover();
        await page.mouse.wheel(0, -1_000_000);
        await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);
        await gateway.resolveDeferred("logs.tail", tail(2_000, 500));
        await page.getByText(/Data log 000500 needle:/).waitFor();
        expect(await stream.evaluate((element) => element.scrollTop)).toBe(0);
        await stream.scrollIntoViewIfNeeded();

        await page.mouse.wheel(0, 1_000_000);
        await expect
          .poll(() => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
          .toBeLessThan(2);
        const last = page.getByText(/Data log 002499 routine:/);
        await expect
          .poll(async () => {
            const [row, clip] = await Promise.all([last.boundingBox(), stream.boundingBox()]);
            return Boolean(
              row &&
              clip &&
              row.y >= clip.y &&
              row.y + row.height <= clip.y + clip.height &&
              row.y >= 0 &&
              row.y + row.height <= height,
            );
          })
          .toBe(true);
        expect(await page.locator(".log-row").count()).toBeLessThan(100);
        expect(
          await page.getByRole("switch", { name: "Auto-follow", exact: true }).isChecked(),
        ).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        await (engine === "chromium" ? suite.closeBrowserContext(context) : context.close());
      }
    },
  );
});
