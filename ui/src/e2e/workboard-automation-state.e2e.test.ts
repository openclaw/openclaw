import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installWorkboardPage } from "./workboard-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Workboard automation state" });

suite.define(() => {
  it("shows the scheduler's disabled state and opens the linked automation without changing it", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const job = {
          id: "job-ops",
          name: "Daily triage",
          enabled: false,
          createdAtMs: 1794600000000,
          updatedAtMs: 1794600000000,
          schedule: { kind: "every", everyMs: 86400000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "Categorize incoming tasks." },
          state: {},
        };
        const boards = [
          {
            id: "ops",
            name: "Operations",
            automationJobId: job.id,
            total: 1,
            active: 1,
            archived: 0,
            byStatus: { ready: 1 },
          },
        ];
        const cards = [
          {
            id: "ops-ready",
            title: "Review release",
            status: "ready",
            priority: "normal",
            labels: [],
            position: 1000,
            createdAt: 1,
            updatedAt: 2,
            agentId: "main",
            metadata: { automation: { boardId: "ops" } },
          },
        ];
        const gateway = await installWorkboardPage(page, suite.server.baseUrl, "ops", {
          "workboard.boards.list": { boards },
          "workboard.cards.list": { boards, cards, statuses: ["ready", "done"] },
          "cron.get": job,
          "cron.list": { jobs: [job], total: 1, hasMore: false, nextOffset: null },
        });
        // The bookmarked board route and its normal card controls consume the same owner.
        await page.goto(suite.server.baseUrl + "workboard/ops");
        await gateway.waitForRequest("cron.get");
        const heading = page.locator(".workboard-heading__automation");
        await heading.getByRole("link", { name: "Open Daily triage", exact: true }).waitFor();
        expect
          .soft(await heading.locator(".workboard-heading__automation-meta").textContent())
          .toContain("Disabled");
        const link = heading.locator(".workboard-heading__automation-name");
        await link.hover();
        const info = page.locator(".workboard-automation-info");
        await info.waitFor({ state: "visible" });
        expect.soft(await info.textContent()).toContain("Disabled");
        const frame = await takeControlUiScreenshotFrame(page, heading, [info], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "disabled-heading.png"), frame.png);
        await page.locator(".workboard-card__title", { hasText: "Review release" }).click();
        const detail = page.locator(".workboard-detail");
        await detail.waitFor();
        const automation = detail.locator(".workboard-board-draft__automation");
        await automation.waitFor();
        expect.soft(await automation.textContent()).toContain("Disabled");
        const target = automation.getByRole("link", { name: "Open Daily triage", exact: true });
        expect(await target.getAttribute("href")).toBe("/automations?job=job-ops");
        await target.click();
        await page.waitForURL(
          (url) => url.pathname === "/automations" && url.searchParams.get("job") === job.id,
        );
        await gateway.waitForRequest("cron.list");
        for (const method of ["cron.run", "cron.update", "cron.remove"]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
      },
    );
  });
});
