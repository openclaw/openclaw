import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { compactCronJobFixture, cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectCount } from "./sidebar-assertions.test-support.ts";
import { sidebarCronJob } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Compact Inbox automation inventory" });

suite.define(() => {
  it("keeps complete Inbox attention without downloading automation instructions", async () => {
    const now = Date.now();
    const payload = {
      kind: "agentTurn" as const,
      message: "Review the synthetic daily report. ".repeat(200),
    };
    const jobs = Array.from({ length: 55 }, (_, index) =>
      sidebarCronJob({
        id: `automation-${index}`,
        name: `Daily report ${index}`,
        agentId: "main",
        createdAtMs: now,
        updatedAtMs: now,
        payload,
        state: { lastRunStatus: "ok", nextRunAtMs: now + 60_000 },
      }),
    );
    const setJob = (index: number, name: string, state: CronJob["state"], enabled = true) => {
      jobs[index] = { ...jobs[index]!, name, state, enabled };
    };
    setJob(50, "Failed daily report", { lastStatus: "error" });
    setJob(51, "Paused report", { lastRunStatus: "error" }, false);
    setJob(52, "Running report", { runningAtMs: 0, nextRunAtMs: now - 600_000 });
    setJob(
      53,
      "Disabled after failures",
      { autoDisabled: { reason: "consecutive-failures", atMs: now, consecutiveErrors: 3 } },
      false,
    );
    setJob(54, "Overdue report", { nextRunAtMs: now - 600_000 });
    const compactJobs = jobs.map(compactCronJobFixture);
    const pageResponse = <T>(entries: T[], offset: number) => ({
      jobs: entries.slice(offset, offset + 50),
      snapshotRevision: "synthetic-inventory-1",
      total: jobs.length,
      limit: 50,
      offset,
      hasMore: offset === 0,
      nextOffset: offset === 0 ? 50 : null,
    });
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const sessionKey = "agent:main:daily-report";
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: [{ role: "assistant", content: "The synthetic daily report is ready." }],
          deferredMethods: ["chat.startup"],
          methodResponses: {
            "cron.list": cronListResponseFixture([
              { match: { offset: 50 }, response: pageResponse(jobs, 50) },
              { response: pageResponse(jobs, 0) },
            ]),
            "cron.status": { enabled: true, triggersEnabled: true, jobs: jobs.length },
            "models.authStatus": { providers: [], ts: now },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("chat.startup");
        expect(await gateway.getRequests("cron.list")).toEqual([]);
        await gateway.resolveDeferred("chat.startup");
        await page
          .locator(".chat-thread")
          .getByText("The synthetic daily report is ready.")
          .waitFor();
        const sidebar = page.locator("openclaw-app-sidebar");
        await expect
          .poll(() => sidebar.locator(".sidebar-issues-button__count").textContent())
          .toBe("3");
        await sidebar.locator(".sidebar-issues-button").click();
        await sidebar.getByRole("tab", { name: /Automations/ }).click();
        const rows = sidebar.locator("[data-attention-kind]");
        await expectCount(rows, 3);
        for (const name of ["Failed daily report", "Disabled after failures", "Overdue report"]) {
          await rows.getByText(name, { exact: true }).waitFor();
        }
        const requests = await gateway.getRequests("cron.list");
        const bytes = (compact: boolean, offset: number) =>
          Buffer.byteLength(
            JSON.stringify(
              compact ? pageResponse(compactJobs, offset) : pageResponse(jobs, offset),
            ),
          );
        const responseBytes = requests.reduce((sum, request) => {
          const params = request.params as { compact?: boolean; offset?: number };
          return sum + bytes(params.compact === true, params.offset ?? 0);
        }, 0);
        const fullBytes = bytes(false, 0) + bytes(false, 50);
        expect(responseBytes).toBeLessThan(fullBytes / 10);
        expect(requests).toHaveLength(2);
      },
    );
  });
});
