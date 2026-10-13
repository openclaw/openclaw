import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { compactCronJobFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Compact Inbox automation inventory" });

suite.define(() => {
  it("keeps complete Inbox attention without downloading automation instructions", async () => {
    const now = Date.now();
    const payload = {
      kind: "agentTurn" as const,
      message: "Review the synthetic daily report. ".repeat(200),
    };
    const jobs: CronJob[] = Array.from({ length: 55 }, (_, index) => ({
      id: `automation-${index}`,
      name: `Daily report ${index}`,
      agentId: "main",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload,
      state: { lastRunStatus: "ok", nextRunAtMs: now + 60_000 },
    }));
    jobs[50] = { ...jobs[50]!, name: "Failed daily report", state: { lastStatus: "error" } };
    jobs[51] = {
      ...jobs[51]!,
      name: "Paused report",
      enabled: false,
      state: { lastRunStatus: "error" },
    };
    jobs[52] = {
      ...jobs[52]!,
      name: "Running report",
      state: { runningAtMs: 0, nextRunAtMs: now - 600_000 },
    };
    jobs[53] = {
      ...jobs[53]!,
      name: "Disabled after failures",
      enabled: false,
      state: { autoDisabled: { reason: "consecutive-failures", atMs: now, consecutiveErrors: 3 } },
    };
    jobs[54] = { ...jobs[54]!, name: "Overdue report", state: { nextRunAtMs: now - 600_000 } };
    const compactJobs = jobs.map(compactCronJobFixture);
    const pageResponse = (compact: boolean, offset: number) => ({
      jobs: (compact ? compactJobs : jobs).slice(offset, offset + 50),
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
            "cron.list": {
              cases: [
                { match: { compact: true, offset: 50 }, response: pageResponse(true, 50) },
                { match: { compact: true }, response: pageResponse(true, 0) },
                { match: { offset: 50 }, response: pageResponse(false, 50) },
                { response: pageResponse(false, 0) },
              ],
            },
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
        await expect.poll(() => rows.count()).toBe(3);
        for (const name of ["Failed daily report", "Disabled after failures", "Overdue report"]) {
          await rows.getByText(name, { exact: true }).waitFor();
        }
        const requests = await gateway.getRequests("cron.list");
        const responseBytes = requests.reduce((sum, request) => {
          const params = request.params as { compact?: boolean; offset?: number };
          return (
            sum +
            Buffer.byteLength(
              JSON.stringify(pageResponse(params.compact === true, params.offset ?? 0)),
            )
          );
        }, 0);
        const fullBytes = [0, 50].reduce(
          (sum, offset) => sum + Buffer.byteLength(JSON.stringify(pageResponse(false, offset))),
          0,
        );
        const proof = {
          responseBytes,
          fullBytes,
          requests: requests.map((request) => request.params),
          renderedRows: 3,
        };
        await writeFile(
          path.join(suite.artifactDir, "inventory.json"),
          `${JSON.stringify(proof, null, 2)}\n`,
        );
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({ path: path.join(suite.artifactDir, "inbox.png") });
        }
        expect(responseBytes).toBeLessThan(fullBytes / 10);
        expect(requests).toHaveLength(2);
      },
    );
  });
});
