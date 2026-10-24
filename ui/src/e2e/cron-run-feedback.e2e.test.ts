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

const outcomes = [
  {
    reason: "already-running",
    mode: "force",
    message: "This automation is already running.",
    role: "status",
  },
  { reason: "not-due", mode: "due", message: "This automation is not due yet.", role: "status" },
  {
    reason: "queued",
    mode: "force",
    message: "Run queued. Run ID: synthetic-run-alpha",
    role: "status",
  },
  { reason: "error", mode: "force", message: "Synthetic run request unavailable", role: "alert" },
] as const;

suite.define(() => {
  it.each(
    outcomes.map((outcome) => ({
      ...outcome,
      sameJob: outcome.reason === "queued" || outcome.reason === "not-due",
    })),
  )(
    "attributes $reason feedback to the requested automation (same job=$sameJob)",
    async ({ reason, mode, message, role, sameJob }) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const alpha = job("feedback-alpha", "Alpha synthetic automation");
        const beta = job("feedback-beta", "Beta synthetic automation");
        const selected = sameJob ? alpha : beta;
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          methodResponses: cronResponses([alpha, beta]),
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const alphaRow = page.locator(`[data-test-id="cron-row-${alpha.id}"]`);
        await alphaRow.waitFor({ state: "visible" });
        await gateway.deferNext("cron.run", { id: alpha.id, mode });
        if (mode === "due") {
          await alphaRow.locator(".cron-job-menu__trigger").click();
          await alphaRow.locator('[data-value="run-if-due"]').click();
        } else {
          await page.locator(`[data-test-id="cron-row-run-${alpha.id}"]`).click();
        }
        const request = await gateway.waitForRequest("cron.run");
        expect(request.params).toMatchObject({ id: alpha.id, mode });

        // Row selection remains available while the previously admitted action settles.
        await page.locator(`[data-test-id="cron-row-${selected.id}"] .cron-table__name`).click();
        await expect
          .poll(() => page.locator(".cron-detail-title").textContent())
          .toContain(selected.name);
        const selectedRun = page.locator('[data-test-id="cron-run-now"]');
        await expect.poll(() => selectedRun.isEnabled()).toBe(false);
        expect(await page.locator(".cron-error-banner").count()).toBe(0);
        if (reason === "error") {
          await gateway.rejectDeferred("cron.run", { code: "UNAVAILABLE", message });
        } else if (reason === "queued") {
          await gateway.resolveDeferred("cron.run", {
            ok: true,
            enqueued: true,
            runId: "synthetic-run-alpha",
          });
        } else {
          await gateway.resolveDeferred("cron.run", { ok: true, ran: false, reason });
        }
        // The action's busy control settles after its feedback publication.
        await expect.poll(() => selectedRun.isEnabled()).toBe(true);
        // Only failures are announced as alerts; answered requests are neutral status.
        const feedback = await page.getByRole(role).filter({ hasText: message }).allTextContents();
        expect(feedback.join("\n")).toContain(message);
        expect(await page.locator(".cron-error-banner").count()).toBe(role === "alert" ? 1 : 0);
        if (!sameJob) {
          expect(feedback.join("\n")).toContain(alpha.name);
        }
        expect(await page.locator(".cron-detail-title").textContent()).toContain(selected.name);
        expect(await gateway.getRequests("cron.run")).toHaveLength(1);
        expect(pageErrors).toEqual([]);
      });
    },
  );

  it.each(outcomes.filter(({ reason }) => reason === "queued" || reason === "error"))(
    "keeps $reason feedback from an overview row on the overview",
    async ({ reason, mode, message, role }) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const alpha = job("feedback-alpha", "Alpha synthetic automation");
        const gateway = await installMockGateway(page, {
          methodResponses: cronResponses([
            alpha,
            job("feedback-beta", "Beta synthetic automation"),
          ]),
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const alphaRow = page.locator(`[data-test-id="cron-row-${alpha.id}"]`);
        await alphaRow.waitFor({ state: "visible" });
        await gateway.deferNext("cron.run", { id: alpha.id, mode });
        await page.locator(`[data-test-id="cron-row-run-${alpha.id}"]`).click();
        await gateway.waitForRequest("cron.run");
        if (reason === "error") {
          await gateway.rejectDeferred("cron.run", { code: "UNAVAILABLE", message });
        } else {
          await gateway.resolveDeferred("cron.run", {
            ok: true,
            enqueued: true,
            runId: "synthetic-run-alpha",
          });
        }
        await expect
          .poll(() => page.getByRole(role).filter({ hasText: message }).allTextContents())
          .toEqual([`${alpha.name}: ${message}`]);
        expect(await page.locator('[data-panel-mode="overview"]').count()).toBe(1);
        expect(await page.locator(".cron-error-banner").count()).toBe(role === "alert" ? 1 : 0);
      });
    },
  );

  it("keeps the Create & run now acknowledgement after returning to the overview", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const created = job("feedback-created", "Created synthetic automation");
      const gateway = await installMockGateway(page, {
        methodResponses: {
          ...cronResponses([]),
          "cron.add": created,
          "cron.run": { ok: true, enqueued: true, runId: "synthetic-run-created" },
        },
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator("#cron-name").fill(created.name);
      await page.locator("#cron-payload-text").fill("Synthetic run feedback check");
      await gateway.setMethodResponse("cron.list", cronResponses([created])["cron.list"]);
      await page.locator('[data-test-id="cron-submit-run"]').click();
      const request = await gateway.waitForRequest("cron.run");
      expect(request.params).toMatchObject({ id: created.id, mode: "force" });
      await expect
        .poll(() => page.getByRole("status").filter({ hasText: "Run queued" }).allTextContents())
        .toEqual([`${created.name}: Run queued. Run ID: synthetic-run-created`]);
      expect(await page.locator('[data-panel-mode="overview"]').count()).toBe(1);
      expect(await page.locator(".cron-error-banner").count()).toBe(0);
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
