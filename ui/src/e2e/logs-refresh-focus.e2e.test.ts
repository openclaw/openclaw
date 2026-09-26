import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Logs refresh keyboard focus" });
const tail = {
  file: "/tmp/logs-focus-fixture.log",
  cursor: 1,
  lines: ["synthetic log entry"],
};

async function tabTo(page: Page, target: Locator) {
  for (let index = 0; index < 100; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error("Native Tab did not reach the Logs control");
}

function isFocused(target: Locator) {
  return target.evaluate((element) => element === document.activeElement);
}

suite.define(() => {
  for (const width of [1440, 390]) {
    it.each([
      ["Enter", "success"],
      ["Space", "success"],
      ["Enter", "failure"],
      ["Space", "failure"],
    ])(`preserves %s refresh focus through %s at ${width}px`, async (key, outcome) => {
      await suite.withPage({ viewport: { width, height: 844 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, { methodResponses: { "logs.tail": tail } });
        await page.goto(`${suite.server.baseUrl}logs`);
        await page.getByText("synthetic log entry", { exact: true }).waitFor();
        const refresh = page
          .locator("openclaw-logs-page .settings-section__actions button")
          .first();
        await tabTo(page, refresh);
        const before = (await gateway.getRequests("logs.tail")).length;
        await gateway.deferNext("logs.tail");
        await page.keyboard.press(key);
        await gateway.waitForRequest("logs.tail", { after: before });
        await expect.poll(() => refresh.textContent()).toContain("Loading");
        expect(await isFocused(refresh)).toBe(true);
        expect(await refresh.getAttribute("aria-disabled")).toBe("true");
        expect(await refresh.getAttribute("aria-busy")).toBe("true");
        await page.keyboard.press("Enter");
        await page.keyboard.press("Space");
        // A pointer activation must be inert too, without Playwright's ARIA actionability wait.
        await refresh.evaluate((element: HTMLButtonElement) => element.click());
        expect((await gateway.getRequests("logs.tail")).length).toBe(before + 1);
        if (outcome === "failure") {
          await gateway.rejectDeferred("logs.tail", { message: "Refresh fixture failed" });
          await page.getByText("Refresh fixture failed", { exact: false }).waitFor();
          expect(await page.locator(".log-message").allTextContents()).toEqual(tail.lines);
        } else {
          await gateway.resolveDeferred("logs.tail", tail);
        }
        await expect.poll(() => refresh.textContent()).toContain("Refresh");
        expect(await isFocused(refresh)).toBe(true);
        expect(await refresh.getAttribute("aria-disabled")).toBe("false");
        await page.keyboard.press("Tab");
        expect(await isFocused(page.getByRole("button", { name: "Export visible" }))).toBe(true);
      });
    });
  }

  it("leaves intentional focus movement alone and preserves focus during quiet polling", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { methodResponses: { "logs.tail": tail } });
      await page.goto(`${suite.server.baseUrl}logs`);
      await page.getByText("synthetic log entry", { exact: true }).waitFor();
      const refresh = page.locator("openclaw-logs-page .settings-section__actions button").first();
      await tabTo(page, refresh);
      await gateway.deferNext("logs.tail");
      await page.keyboard.press("Enter");
      await expect.poll(() => refresh.textContent()).toContain("Loading");
      await page.keyboard.press("Tab");
      const exportButton = page.getByRole("button", { name: "Export visible" });
      expect(await isFocused(exportButton)).toBe(true);
      await gateway.resolveDeferred("logs.tail", tail);
      await expect.poll(() => refresh.textContent()).toContain("Refresh");
      expect(await isFocused(exportButton)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await isFocused(refresh)).toBe(true);
      const beforePoll = (await gateway.getRequests("logs.tail")).length;
      await gateway.deferNext("logs.tail");
      const request = await gateway.waitForRequest("logs.tail", { after: beforePoll });
      expect(request.params).toEqual({ cursor: 1, limit: 500, maxBytes: 250_000 });
      await expect.poll(() => refresh.getAttribute("aria-busy")).toBe("true");
      expect(await refresh.textContent()).toContain("Refresh");
      expect(await isFocused(refresh)).toBe(true);
      await page.keyboard.press("Enter");
      expect((await gateway.getRequests("logs.tail")).length).toBe(beforePoll + 1);
      await gateway.resolveDeferred("logs.tail", {
        ...tail,
        cursor: 2,
        lines: ["appended log entry"],
      });
      await page.getByText("appended log entry", { exact: true }).waitFor();
      expect(await page.locator(".log-message").allTextContents()).toEqual([
        ...tail.lines,
        "appended log entry",
      ]);
      expect(await isFocused(refresh)).toBe(true);
    });
  });
});
