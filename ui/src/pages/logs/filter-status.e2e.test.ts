import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({ name: "Logs filter status accessibility" });
const options = {
  locale: "en-US",
  serviceWorkers: "block" as const,
  viewport: { width: 1280, height: 900 },
};
const emptyMessage = "No log entries.";
const line = (message: string, level: string) =>
  JSON.stringify({ message, time: "2026-10-25T12:00:00Z", _meta: { logLevelName: level } });
const tail = (lines: string[], reset = false) => ({
  file: "/synthetic/gateway.log",
  cursor: 2,
  lines,
  reset,
});

suite.define(() => {
  it("keeps empty filter feedback in a persistent status outside log rows", async () => {
    await suite.withPage(options, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "logs.tail": tail(
            [line("Synthetic service ready", "INFO"), line("Synthetic retry failed", "ERROR")],
            true,
          ),
        },
      });
      await page.goto(`${suite.server.baseUrl}logs`);
      const stream = page.getByRole("region", { name: "Logs", exact: true });
      const filter = page.getByRole("textbox", { name: "Filter", exact: true });
      await expect.poll(() => stream.locator(".log-row").count()).toBe(2);
      const [originalStatus] = await stream.getByRole("status").elementHandles();
      await filter.focus();
      await filter.pressSequentially("unmatched synthetic query");
      await stream.getByText(emptyMessage, { exact: true }).waitFor();
      await writeFile(
        path.join(suite.artifactDir, "filtered-empty-ax.txt"),
        await stream.ariaSnapshot(),
      );
      await page.screenshot({ path: path.join(suite.artifactDir, "filtered-empty.png") });
      expect(await stream.getByRole("status").count()).toBe(1);
      if (!originalStatus) {
        throw new Error("The empty-result status must exist before filtering");
      }
      const status = stream.getByRole("status");
      expect(await status.textContent()).toBe(emptyMessage);
      expect(
        await status.evaluate((element, original) => element === original, originalStatus),
      ).toBe(true);
      expect(await filter.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await stream.getAttribute("aria-live")).toBeNull();

      await filter.press("ControlOrMeta+A");
      await filter.press("Backspace");
      await expect.poll(() => stream.locator(".log-row").count()).toBe(2);
      expect(await status.textContent()).toBe("");
      for (const level of ["info", "error"]) {
        const checkbox = page.getByRole("checkbox", { name: level, exact: true });
        await checkbox.focus();
        await checkbox.press("Space");
      }
      await stream.getByText(emptyMessage, { exact: true }).waitFor();
      expect(await status.textContent()).toBe(emptyMessage);
      const errorLevel = page.getByRole("checkbox", { name: "error", exact: true });
      expect(await errorLevel.evaluate((element) => document.activeElement === element)).toBe(true);

      const observation = await status.evaluateHandle((element) => {
        const records: MutationRecord[] = [];
        const observer = new MutationObserver((batch) => records.push(...batch));
        observer.observe(element, { childList: true, characterData: true, subtree: true });
        return { records, observer };
      });
      await gateway.deferNext("logs.tail");
      const reads = (await gateway.getRequests("logs.tail")).length;
      await expect
        .poll(async () => (await gateway.getRequests("logs.tail")).length)
        .toBeGreaterThan(reads);
      await gateway.resolveDeferred("logs.tail", tail([]));
      await expect
        .poll(() => page.getByRole("button", { name: "Refresh", exact: true }).isEnabled())
        .toBe(true);
      expect(
        await status.evaluate((element, original) => element === original, originalStatus),
      ).toBe(true);
      expect(await observation.evaluate(({ records }) => records.length)).toBe(0);
      await observation.evaluate(({ observer }) => observer.disconnect());
      await observation.dispose();
      await originalStatus.dispose();
    });

    await suite.withPage(options, async ({ page }) => {
      const gateway = await installMockGateway(page, { deferredMethods: ["logs.tail"] });
      await page.goto(`${suite.server.baseUrl}logs`);
      const stream = page.getByRole("region", { name: "Logs", exact: true });
      await stream.getByRole("status", { name: "Loading…" }).waitFor();
      expect(await stream.getByText(emptyMessage, { exact: true }).count()).toBe(0);
      await gateway.resolveDeferred("logs.tail", tail([], true));
      await stream.getByText(emptyMessage, { exact: true }).waitFor();
      expect(await stream.getByRole("status").textContent()).toBe(emptyMessage);
    });
  });
});
