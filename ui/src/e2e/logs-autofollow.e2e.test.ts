import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  installMockGateway,
  pauseVirtualClock,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI logs auto-follow mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const viewport = { height: 800, width: 1_200 };

function logLine(index: number, level = "info") {
  return JSON.stringify({
    "0": JSON.stringify({ subsystem: "autofollow-e2e" }),
    "1": `log line ${index}`,
    time: new Date(Date.UTC(2026, 6, 13, 12, 0, index - 1)).toISOString(),
    _meta: { logLevelName: level },
  });
}
const logLines = Array.from({ length: 200 }, (_, index) => logLine(index + 1));
function tail(cursor: number, lines: string[], reset = false) {
  return { cursor, lines, reset, file: "/tmp/openclaw.log" };
}
async function visibility(page: Page, value: "hidden" | "visible", repeats = 1) {
  await page.evaluate(
    (state) => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: state.value,
      });
      for (let i = 0; i < state.repeats; i++) {
        document.dispatchEvent(new Event("visibilitychange"));
      }
    },
    { value, repeats },
  );
}

suite.define(() => {
  it("pauses hidden log reads and catches up without overlapping a slow tail", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "logs.tail": tail(1, ["initial"], true),
        },
      });
      await page.clock.install();
      await page.goto(`${suite.server.baseUrl}logs`);
      await page.getByText("initial", { exact: true }).waitFor();
      await pauseVirtualClock(page);
      const reads = (await gateway.getRequests("logs.tail")).length;
      await visibility(page, "hidden");
      await page.clock.runFor(6_000);
      expect(await gateway.getRequests("logs.tail")).toHaveLength(reads);

      await gateway.deferNext("logs.tail");
      await visibility(page, "visible", 2);
      const catchup = await gateway.getRequests("logs.tail");
      expect(catchup).toHaveLength(reads + 1);
      expect(catchup.at(-1)?.params).toMatchObject({ cursor: 1 });
      await page.clock.runFor(6_000);
      expect(await gateway.getRequests("logs.tail")).toHaveLength(reads + 1);
      await gateway.resolveDeferred("logs.tail", tail(2, ["resumed"]));
      await page.getByText("resumed", { exact: true }).waitFor();
      expect(await page.locator(".log-message").allTextContents()).toEqual(["initial", "resumed"]);

      await evaluateControlUiContext(page, (context) => context.navigate("about"));
      await waitForControlUiRoute(page, { routeId: "about" });
      await page.locator("openclaw-logs-page").waitFor({ state: "detached" });
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.clock.runFor(2_000);
      expect(await gateway.getRequests("logs.tail")).toHaveLength(reads + 1);
    });
  });

  it("returns to the newest line when auto-follow is re-enabled", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
      },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "logs.tail": {
              sequence: [
                tail(logLines.length, logLines, true),
                tail(logLines.length + 1, [logLine(201, "warn")]),
                tail(logLines.length + 1, []),
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}logs`);
        await expect
          .poll(() => page.locator(".log-row").first().getAttribute("aria-setsize"))
          .toBe(String(logLines.length));
        await expect.poll(() => page.locator(".log-row").count()).toBeLessThan(100);
        const limits = { limit: 500, maxBytes: 250_000 };
        expect((await gateway.getRequests("logs.tail"))[0]?.params).toEqual(limits);
        await expect
          .poll(async () => (await gateway.getRequests("logs.tail")).length, { timeout: 5000 })
          .toBeGreaterThanOrEqual(2);
        expect((await gateway.getRequests("logs.tail"))[1]?.params).toEqual({
          cursor: logLines.length,
          ...limits,
        });
        await expect
          .poll(() => page.locator(".log-row").first().getAttribute("aria-setsize"))
          .toBe(String(logLines.length + 1));
        await page.locator(".log-row", { hasText: "log line 201" }).waitFor();

        const stream = page.locator(".log-stream");
        const bottomGap = () =>
          stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
        const autoFollow = page.getByRole("switch", { name: "Auto-follow", exact: true });
        await expect
          .poll(() => stream.evaluate((element) => element.scrollHeight - element.clientHeight))
          .toBeGreaterThan(0);
        await expect.poll(() => autoFollow.isChecked()).toBe(true);
        await autoFollow.click();
        await expect.poll(() => autoFollow.isChecked()).toBe(false);
        await stream.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);

        await autoFollow.click();
        await expect.poll(() => autoFollow.isChecked()).toBe(true);

        await expect.poll(bottomGap).toBeLessThan(2);
        expect(pageErrors).toEqual([]);
      },
    );
  });

  it("keeps End anchored to the final wrapped row as log heights settle", async () => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const lines = Array.from({ length: 130 }, (_, index) =>
        JSON.stringify({
          time: "2026-10-01T12:00:00Z",
          level: "info",
          message: `Wrapped log ${index}: ${"Variable height synthetic content. ".repeat(22)}`,
        }),
      );
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "logs.tail": { sequence: [tail(80, lines.slice(0, 80), true), tail(80, [])] },
        },
      });
      await page.goto(`${suite.server.baseUrl}logs`);
      await expect
        .poll(() => page.locator(".log-row").first().getAttribute("aria-setsize"))
        .toBe("80");
      await expect.poll(() => page.locator(".log-row").count()).toBeLessThan(80);
      await page.getByRole("switch", { name: "Auto-follow", exact: true }).uncheck();
      const stream = page.getByRole("region", { name: "Logs", exact: true });
      await stream.evaluate((element) => (element.scrollTop = 0));
      const after = await gateway.deferNext("logs.tail");
      await gateway.waitForRequest("logs.tail", { after });
      await gateway.resolveDeferred("logs.tail", tail(130, lines.slice(80)));
      await gateway.setMethodResponse("logs.tail", tail(130, []));
      await expect
        .poll(() => page.locator(".log-row").first().getAttribute("aria-setsize"))
        .toBe("130");

      for (const size of [viewport, { width: 480, height: 850 }]) {
        await page.setViewportSize(size);
        await stream.evaluate((element) => (element.scrollTop = 0));
        await stream.focus();
        await page.keyboard.press("End");
        await expect
          .poll(() => stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
          .toBeLessThan(2);
        const lastRow = page.locator(".log-row", { hasText: "Wrapped log 129:" });
        await expect
          .poll(async () => {
            const [row, region] = await Promise.all([lastRow.boundingBox(), stream.boundingBox()]);
            return Boolean(
              row && region && row.y < region.y + region.height && row.y + row.height > region.y,
            );
          })
          .toBe(true);
        await expect.poll(() => page.locator(".log-row").count()).toBeLessThan(100);
      }
    });
  });
});
