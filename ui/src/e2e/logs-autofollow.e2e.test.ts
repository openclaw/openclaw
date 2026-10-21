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
        await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length);
        const limits = { limit: 500, maxBytes: 250_000 };
        expect((await gateway.getRequests("logs.tail"))[0]?.params).toEqual(limits);
        await expect
          .poll(async () => (await gateway.getRequests("logs.tail")).length, { timeout: 5000 })
          .toBeGreaterThanOrEqual(2);
        expect((await gateway.getRequests("logs.tail"))[1]?.params).toEqual({
          cursor: logLines.length,
          ...limits,
        });
        await expect.poll(() => page.locator(".log-row").count()).toBe(logLines.length + 1);
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
});
