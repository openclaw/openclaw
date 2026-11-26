import type { BrowserContext, Locator, Page } from "playwright";
import { expect } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
} from "./cron-fixtures.test-support.ts";

export async function captureAdditionalStateProof({
  context,
  baseUrl,
  capture,
}: {
  context: BrowserContext;
  baseUrl: string;
  capture: (page: Page, name: string, target: Locator) => Promise<void>;
}) {
  const page = await context.newPage();
  const atMs = Date.now() - 60_000;
  const job = cronJob("release-source-proof", "Review release readiness", {
    configRevision: "synthetic-proof-revision",
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "Review the fictional release checklist and record its status.",
      model: "fixture-provider/fixture-model",
      thinking: "medium",
    },
    state: {
      lastRunStatus: "ok",
      lastRunAtMs: atMs,
      nextRunAtMs: atMs + 120_000,
      lastMeaningfulResult: {
        outcome: "needs_attention",
        summary: "Choose a release source before continuing.",
        atMs,
      },
    },
  });
  try {
    const gateway = await installMockGateway(page, {
      featureMethods: [...cronSidebarFeatureMethods, "cron.get", "cron.runs", "cron.status"],
      methodResponses: {
        "cron.get": job,
        "cron.list": cronList([job], "synthetic-proof"),
        "cron.runs": cronRuns([
          {
            jobId: job.id,
            runId: "synthetic-attention-run",
            runAtMs: atMs,
            ts: atMs,
            action: "finished",
            status: "ok",
            result: {
              outcome: "needs_attention",
              summary: "Choose a release source before continuing.",
            },
          },
        ]),
        "cron.status": { enabled: true, jobs: 1, triggersEnabled: true },
        "models.list": {
          models: [
            {
              id: "fixture-model",
              provider: "fixture-provider",
              name: "Fixture model",
              thinkingLevels: [
                { id: "off", label: "Off" },
                { id: "ultra", label: "Ultra" },
              ],
              thinkingDefault: "ultra",
            },
          ],
        },
      },
    });
    await page.goto(baseUrl + "cron?job=" + job.id);
    const attention = page.locator(".cron-failure-details");
    await expect.poll(() => attention.textContent()).toContain("Choose a release source");
    await capture(page, "needs-attention-820", attention);
    const panel = await attention.elementHandle();
    const publishError = async (lastError: string) => {
      job.state = { ...job.state, lastRunStatus: "error", lastError };
      job.updatedAtMs += 1;
      await gateway.setMethodResponse("cron.get", job);
      await gateway.emitGatewayEvent("cron", {
        action: "finished",
        jobId: job.id,
        status: "error",
        error: lastError,
        job,
      });
    };
    await publishError("The release check stopped before completion.");
    await expect.poll(() => attention.textContent()).toContain("Last run failed");
    expect(await attention.textContent()).not.toContain("Choose a release source");
    expect(await panel!.evaluate((element) => element.isConnected)).toBe(true);
    await capture(page, "execution-error-820", attention);
    await page.locator('[data-test-id="cron-failure-details-toggle"]').click();
    await expect.poll(() => attention.textContent()).toContain("stopped before completion");
    await capture(page, "execution-error-details-820", attention);
    await publishError("The release check exhausted its retry budget.");
    await expect.poll(() => attention.textContent()).toContain("exhausted its retry budget");
    await capture(page, "changed-error-details-820", attention);
    await page.locator('[data-test-id="cron-edit"]').click();
    const warning = page
      .getByRole("status")
      .filter({ hasText: "saved reasoning level is not available" });
    await warning.waitFor();
    await capture(page, "saved-reasoning-warning-820", warning);
    const effort = page.locator('.cron-prompt__run-controls [data-chat-thinking-select="true"]');
    await effort.click();
    const slider = page.locator('.chat-controls__effort-menu [data-chat-thinking-slider="true"]');
    await slider.focus();
    await slider.press("Home");
    await page.keyboard.press("Escape");
    await expect.poll(() => warning.count()).toBe(0);
    await capture(page, "reasoning-recovered-820", effort);
  } finally {
    await page.close();
  }
}
