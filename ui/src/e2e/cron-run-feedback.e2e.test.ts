import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation run feedback ownership",
  startServerBeforeBrowser: true,
});

function job(id: string, name: string) {
  return cronJob(id, name, {
    configRevision: `synthetic-${id}`,
    payload: { kind: "systemEvent", text: "Synthetic run feedback check" },
  });
}

function cronResponses(jobs: CronJob[]) {
  return {
    "cron.list": cronListResponseFixture(cronList(jobs, `run-feedback-${jobs.length}`)),
    "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
    "cron.status": { enabled: true, jobs: jobs.length, triggersEnabled: true },
  };
}

suite.define(() => {
  it.each([
    { reason: "queued", selection: "same" },
    { reason: "error", selection: "other" },
    { reason: "queued", selection: "overview" },
    { reason: "error", selection: "overview" },
  ])("attributes $reason feedback with $selection selection", async ({ reason, selection }) => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const alpha = job("feedback-alpha", "Alpha synthetic automation");
      const beta = job("feedback-beta", "Beta synthetic automation");
      const selected = selection === "same" ? alpha : beta;
      const gateway = await installMockGateway(page, {
        methodResponses: cronResponses([alpha, beta]),
      });
      const message =
        reason === "error"
          ? "Synthetic run request unavailable"
          : "Run queued. Run ID: synthetic-run-alpha";
      const role = reason === "error" ? "alert" : "status";
      await page.goto(suite.server.baseUrl + "cron");
      await gateway.deferNext("cron.run", { id: alpha.id, mode: "force" });
      await page.locator('[data-test-id="cron-row-run-feedback-alpha"]').click();
      expect((await gateway.waitForRequest("cron.run")).params).toMatchObject({
        id: alpha.id,
        mode: "force",
      });
      const selectedRun = page.locator('[data-test-id="cron-run-now"]');
      if (selection !== "overview") {
        await page
          .locator('[data-test-id="cron-row-' + selected.id + '"] .cron-table__name')
          .click();
        await expect
          .poll(() => page.locator(".cron-detail-title").textContent())
          .toContain(selected.name);
        await expect.poll(() => selectedRun.isEnabled()).toBe(false);
        expect(await page.locator(".cron-error-banner").count()).toBe(0);
      }
      if (reason === "error") {
        await gateway.rejectDeferred("cron.run", { code: "UNAVAILABLE", message });
      } else {
        await gateway.resolveDeferred("cron.run", {
          ok: true,
          enqueued: true,
          runId: "synthetic-run-alpha",
        });
      }
      if (selection !== "overview") {
        await expect.poll(() => selectedRun.isEnabled()).toBe(true);
        expect(await page.locator(".cron-detail-title").textContent()).toContain(selected.name);
      } else {
        expect(await page.locator('[data-panel-mode="overview"]').count()).toBe(1);
      }
      await expect
        .poll(() => page.getByRole(role).filter({ hasText: message }).allTextContents())
        .toEqual([selection === "same" ? message : alpha.name + ": " + message]);
      expect(await page.locator(".cron-error-banner").count()).toBe(reason === "error" ? 1 : 0);
      expect(await gateway.getRequests("cron.run")).toHaveLength(1);
    });
  });

  it("clears the run notice when the route search changes", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const alpha = job("feedback-alpha", "Alpha synthetic automation");
      await installMockGateway(page, {
        methodResponses: {
          ...cronResponses([alpha]),
          "cron.run": { ok: true, enqueued: true, runId: "synthetic-run-alpha" },
        },
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator(`[data-test-id="cron-row-${alpha.id}"] .cron-table__name`).click();
      await page.locator('[data-test-id="cron-run-now"]').click();
      const notice = page.getByRole("status").filter({ hasText: "Run queued" });
      await expect.poll(() => notice.count()).toBe(1);
      await page.evaluate((url) => {
        history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, `${suite.server.baseUrl}cron?from=synthetic-link`);
      // A search without a job target keeps the open editor but retires its action feedback.
      await expect.poll(() => notice.count()).toBe(0);
      expect(await page.locator(".cron-detail-title").textContent()).toContain(alpha.name);
    });
  });

  it("announces a queued Run now on the agent Automations panel as status", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const alpha = { ...job("feedback-alpha", "Alpha synthetic automation"), agentId: "main" };
      const gateway = await installMockGateway(page, {
        // The agent panel gates its automation reads and Run now on the advertised methods.
        featureMethods: [...defaultControlUiFeatureMethods, "cron.list", "cron.run"],
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main", name: "Main agent" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "cron.list": cronResponses([alpha])["cron.list"],
          "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
          "cron.run": { ok: true, enqueued: true, runId: "synthetic-run-alpha" },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/agents/main/cron`);
      const row = page.locator(".settings-row").filter({ hasText: alpha.name });
      await row.getByRole("button", { name: "Run now" }).click();
      await gateway.waitForRequest("cron.run");
      await expect
        .poll(() => page.getByRole("status").filter({ hasText: "Run queued" }).allTextContents())
        .toEqual([`${alpha.name}: Run queued. Run ID: synthetic-run-alpha`]);
      expect(await page.locator("#agent-panel .callout.danger").count()).toBe(0);
    });
  });
});
