import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session kinds" });
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("sorts and groups by displayed kind while preserving pins", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const sessions = [
        { key: "agent:main:alpha", kind: "direct", label: "Alpha conversation", updatedAt: 6 },
        { key: "agent:main:cron:daily", kind: "direct", label: "Daily check", updatedAt: 5 },
        { key: "agent:main:beta", kind: "direct", label: "Beta conversation", updatedAt: 4 },
        { key: "agent:main:room", kind: "group", label: "Project room", updatedAt: 3 },
        { key: "cron:weekly", kind: "direct", label: "Weekly check", updatedAt: 2 },
        {
          key: "agent:main:pinned",
          kind: "direct",
          label: "Pinned conversation",
          updatedAt: 1,
          pinned: true,
          pinnedAt: 100,
        },
      ];
      const gateway = await installMockGateway(page, {
        sessionKey: "unknown",
        methodResponses: {
          "sessions.list": {
            count: sessions.length,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions,
            ts: 10,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}sessions`);
      const table = page.locator(".sessions-table");
      await expect.poll(() => table.locator(".session-data-row").count()).toBe(6);
      const kinds = () => table.locator(".session-data-row .session-kind").allTextContents();
      const kindHeader = table.locator("th[data-sortable]").filter({ hasText: "Kind" });
      await kindHeader.getByRole("button").click();
      await expect.poll(() => kindHeader.getAttribute("aria-sort")).toBe("descending");
      expect.soft(await kinds()).toEqual(["direct", "group", "direct", "direct", "cron", "cron"]);
      await kindHeader.getByRole("button").click();
      await expect.poll(() => kindHeader.getAttribute("aria-sort")).toBe("ascending");
      const ascending = await kinds();
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "kind-sort.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [table]),
        );
      }
      expect.soft(ascending).toEqual(["direct", "cron", "cron", "direct", "direct", "group"]);

      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.locator("wa-popover.sessions-filter-popover[open]").waitFor();
      await page.locator(".session-groupby__select").selectOption("kind");
      await page.keyboard.press("Escape");
      await page.locator("wa-popover.sessions-filter-popover").waitFor({ state: "hidden" });
      await table.locator(".session-group-row").first().waitFor();
      const groups = await table.locator(".session-group-row__label").allTextContents();
      if (captureUiProof) {
        await writeFile(
          path.join(suite.artifactDir, "kind-groups.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [table]),
        );
        await writeFile(
          path.join(suite.artifactDir, "kind-proof.json"),
          JSON.stringify(
            { ascending, groups, requests: await gateway.getRequests("sessions.list") },
            null,
            2,
          ),
        );
      }
      expect.soft(groups).toEqual(["cron", "direct", "group"]);
      expect.soft(await kinds()).toEqual(["cron", "cron", "direct", "direct", "direct", "group"]);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.locator("wa-popover.sessions-filter-popover[open]").waitFor();
      await page.locator(".session-groupby__select").selectOption("none");
      await expect.poll(() => table.locator(".session-group-row").count()).toBe(0);
      expect(await table.locator(".session-data-row").first().textContent()).toContain(
        "Pinned conversation",
      );
      await page.keyboard.press("Escape");
      await page.locator("wa-popover.sessions-filter-popover").waitFor({ state: "hidden" });
      await table
        .locator(".session-data-row")
        .filter({ hasText: "Daily check" })
        .locator(".session-details-toggle")
        .click();
      const details = table.locator(".session-details-panel");
      await details.waitFor();
      expect(await details.locator(".session-kind").textContent()).toBe("cron");
      expect(
        await details
          .locator(".session-detail-stat")
          .filter({ has: page.locator(".session-detail-stat__label", { hasText: "Kind" }) })
          .locator(".session-detail-stat__value")
          .textContent(),
      ).toBe("cron");
    });
  });
});
