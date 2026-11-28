import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  buildAggregatesFromSessions,
  usageSession,
  usageTotals,
} from "../pages/usage/view.test-support.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  installUsageOverviewGateway,
  openUsageFilter,
} from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Usage filter readiness mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  for (const width of [1440, 390]) {
    it(`does not claim a provider search is empty before its range is available at ${width}px`, async () => {
      await suite.withPage(
        {
          colorScheme: "light",
          locale: "en-US",
          timezoneId: "UTC",
          viewport: { width, height: 1100 },
          serviceWorkers: "block",
        },
        async ({ page }) => {
          const now = Date.now();
          const date = new Date(now).toISOString().slice(0, 10);
          const sessions = [usageSession("agent:main:filter-proof", "main", "openai")];
          const response = {
            updatedAt: now,
            startDate: date,
            endDate: date,
            sessions,
            totals: usageTotals(120, 1),
            aggregates: buildAggregatesFromSessions(sessions),
          };
          const gateway = await installUsageOverviewGateway(page, {
            methodResponses: {
              "sessions.usage": response,
              "usage.status": { updatedAt: now, providers: [] },
            },
          });
          const openProvider = async () => {
            if (width > 600) {
              return openUsageFilter(page, "Provider");
            }
            const sheet = page.locator('[aria-controls="usage-filter-sheet"]');
            if ((await sheet.getAttribute("aria-expanded")) !== "true") {
              await sheet.click();
            }
            const trigger = page.getByRole("button", { name: "Provider All", exact: true });
            await trigger.click();
            return page.locator(`[id="${await trigger.getAttribute("aria-controls")}"]`);
          };
          await page.goto(suite.server.baseUrl + "usage");
          await page.getByText("main session", { exact: true }).waitFor();
          const before = (await gateway.getRequests("sessions.usage")).length;
          await gateway.deferNext("sessions.usage");
          const all = page
            .getByRole("group", { name: "Reporting range", exact: true })
            .getByRole("button", { name: "All", exact: true });
          await all.click();
          await gateway.waitForRequest("sessions.usage", { after: before });
          let picker = await openProvider();
          let search = picker.getByRole("textbox");
          await search.fill("openai");
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const artifacts = createControlUiE2eArtifactDir("usage-filter-readiness");
            const frame = await takeControlUiScreenshotFrame(page, picker, [picker], {
              elements: [picker],
              animations: "disabled",
            });
            await writeFile(path.join(artifacts, `pending-provider-${width}.png`), frame.png);
          }
          expect.soft(await picker.locator(".usage-value-picker__empty").count()).toBe(0);
          await gateway.rejectDeferred("sessions.usage", {
            code: "UNAVAILABLE",
            message: "Usage report temporarily unavailable",
          });
          await page.getByText("Usage report temporarily unavailable", { exact: true }).waitFor();
          expect.soft(await picker.locator(".usage-value-picker__empty").count()).toBe(0);
          expect(await search.inputValue()).toBe("openai");
          await page.keyboard.press("Escape");
          if (width <= 600) {
            await page.locator("#usage-filter-sheet .oc-sheet__close").click();
          } else {
            await page.locator(".usage-filter-menu__trigger").click();
          }
          // Reselecting the current range retries on both desktop and phone.
          await all.click();
          await page.getByText("main session", { exact: true }).waitFor();
          picker = await openProvider();
          search = picker.getByRole("textbox");
          await picker.getByRole("menuitemcheckbox", { name: "openai", exact: true }).waitFor();
          await search.fill("no-such-provider");
          await picker.locator(".usage-value-picker__empty").waitFor();
          expect(await picker.locator(".usage-value-picker__empty").textContent()).toContain(
            "no-such-provider",
          );
          await search.fill("openai");
          const option = picker.getByRole("menuitemcheckbox", { name: "openai", exact: true });
          await option.click();
          await expect.poll(() => option.getAttribute("aria-checked")).toBe("true");
          await gateway.waitForRequest("sessions.usage", {
            match: { query: "provider:openai " },
          });
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        },
      );
    });
  }
});
