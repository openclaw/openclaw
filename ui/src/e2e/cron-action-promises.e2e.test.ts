import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Automation action promises" });

suite.define(() => {
  it("distinguishes stopping a running automation from enabling future activity", async () => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        viewport: { width: 1280, height: 800 },
        colorScheme: "dark",
      },
      async ({ page }) => {
        const job = cronJob("release-check", "Weekly release check", {
          configRevision: "enabled-revision",
          description: "Review the release checklist and report any missing evidence.",
          schedule: { kind: "every", everyMs: 3_600_000 },
          state: { runningAtMs: Date.now() },
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponseFixture(cronList([job], "initial")),
            "cron.get": job,
            "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
          },
        });
        await page.goto(suite.server.baseUrl + "cron");
        const row = page.locator('[data-test-id="cron-row-release-check"]');
        const toggleHost = page.locator('[data-test-id="cron-row-toggle-release-check"]');
        const toggle = toggleHost.getByRole("switch");
        await toggle.waitFor();
        await toggle.hover();
        const label = await tooltipTitleText(toggleHost);
        await page.getByRole("tooltip").filter({ hasText: label }).waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".cron-page"),
            [row, toggleHost, page.getByRole("tooltip").filter({ hasText: label })],
            { animations: "disabled" },
          );
          await writeFile(path.join(suite.artifactDir, "running-action.png"), frame.png);
        }
        // Soft assertion retains the real handler proof on the unfixed main baseline.
        expect
          .soft(await toggle.getAttribute("aria-label"))
          .toBe("Stop and disable: Weekly release check");
        expect.soft(label).toBe("Stop and disable: Weekly release check");
        expect(await gateway.getRequests("cron.update")).toHaveLength(0);
        await gateway.deferNext("cron.update");
        await toggle.click();
        expect((await gateway.waitForRequest("cron.update")).params).toEqual({
          id: job.id,
          expectedConfigRevision: "enabled-revision",
          patch: { enabled: false },
        });
        // The request only changes enablement; its acknowledgement is not a stopped-run receipt.
        const disabled = { ...job, enabled: false, configRevision: "disabled-revision" };
        await gateway.setMethodResponse(
          "cron.list",
          cronListResponseFixture(cronList([disabled], "disabled")),
        );
        await gateway.setMethodResponse("cron.get", disabled);
        await gateway.resolveDeferred("cron.update", disabled);
        await expect.poll(() => toggle.getAttribute("aria-disabled")).toBeNull();
        expect(await row.getByRole("img", { name: "Running", exact: true }).count()).toBe(1);
        expect.soft(await toggle.getAttribute("aria-label")).toBe("Enable: Weekly release check");
        await row.locator(".cron-table__name").click();
        const detailToggle = page
          .locator('[data-test-id="cron-toggle-enabled"]')
          .getByRole("switch");
        await detailToggle.waitFor();
        expect
          .soft(await detailToggle.getAttribute("aria-label"))
          .toBe("Enable: Weekly release check");
        await gateway.setMethodResponse("cron.update", job);
        await gateway.setMethodResponse(
          "cron.list",
          cronListResponseFixture(cronList([job], "enabled")),
        );
        await gateway.setMethodResponse("cron.get", job);
        await detailToggle.click();
        await expect.poll(() => gateway.getRequests("cron.update")).toHaveLength(2);
        expect((await gateway.getRequests("cron.update"))[1]?.params).toEqual({
          id: job.id,
          expectedConfigRevision: "disabled-revision",
          patch: { enabled: true },
        });
        expect(await gateway.getRequests("cron.run")).toHaveLength(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
      },
    );
  });
});
