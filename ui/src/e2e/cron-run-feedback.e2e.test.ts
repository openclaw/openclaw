import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation run feedback ownership",
  startServerBeforeBrowser: true,
});

function job(id: string, name: string): CronJob {
  return {
    id,
    name,
    configRevision: `synthetic-${id}`,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Synthetic run feedback check" },
    state: {},
  };
}

const outcomes = [
  { reason: "already-running", mode: "force", message: "This automation is already running." },
  { reason: "not-due", mode: "due", message: "This automation is not due yet." },
  { reason: "queued", mode: "force", message: "Run queued. Run ID: synthetic-run-alpha" },
  { reason: "error", mode: "force", message: "Synthetic run request unavailable" },
] as const;

suite.define(() => {
  it.each(
    outcomes.flatMap(({ reason, mode, message }) =>
      [true, false].map((sameJob) => ({ reason, mode, message, sameJob })),
    ),
  )(
    "attributes $reason feedback to the requested automation (same job=$sameJob)",
    async ({ reason, mode, message, sameJob }) => {
      const artifacts = createControlUiE2eArtifactDir(`cron-run-feedback-${reason}-${sameJob}`);
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const alpha = job("feedback-alpha", "Alpha synthetic automation");
        const beta = job("feedback-beta", "Beta synthetic automation");
        const selected = sameJob ? alpha : beta;
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(String(error)));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              jobs: [alpha, beta],
              snapshotRevision: "run-feedback-fixture",
              total: 2,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 2, triggersEnabled: true },
          },
        });
        try {
          await page.goto(`${suite.server.baseUrl}cron`);
          const alphaRow = page.locator(`[data-test-id="cron-row-${alpha.id}"]`);
          await alphaRow.waitFor({ state: "visible" });
          await gateway.deferNext("cron.run", { id: alpha.id, mode });
          if (mode === "due") {
            await alphaRow.locator(".cron-job-menu__trigger").click();
            await alphaRow.locator('wa-dropdown-item[value="run-if-due"]').click();
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
          await page.screenshot({ path: `${artifacts}/pending.png` });
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
          const feedback = await page.locator(".cron-error-banner").allTextContents();
          expect(feedback.join("\n")).toContain(message);
          if (!sameJob) {
            expect(feedback.join("\n")).toContain(alpha.name);
          }
          expect(await page.locator(".cron-detail-title").textContent()).toContain(selected.name);
          expect(await gateway.getRequests("cron.run")).toHaveLength(1);
          expect(pageErrors).toEqual([]);
        } finally {
          await page.screenshot({ path: `${artifacts}/final.png` });
        }
      });
    },
  );
});
