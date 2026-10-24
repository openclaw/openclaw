import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createCronJob, cronJobsListResponse } from "../lib/cron/cron.test-support.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI automation scratch" });

const job = createCronJob("migrated-checklist", "Evening checklist", {
  schedule: { kind: "every", everyMs: 1_800_000 },
  sessionTarget: "main",
  payload: { kind: "agentTurn", message: "Review the evening checklist" },
});

const scratchContent = "# Evening checklist\n\n- Inspect queued work.\n";
const scratchResponse = {
  scratch: { content: scratchContent, revision: 1, updatedAtMs: 1 },
  currentRevision: 1,
  maxBytes: 262_144,
};

async function openAutomation(page: Page, readOnly = false, scratch: unknown = scratchResponse) {
  const gateway = await installMockGateway(page, {
    ...(readOnly && { operatorScopes: ["operator.read"] }),
    methodResponses: {
      "cron.list": cronListResponseFixture(cronJobsListResponse([job])),
      "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
      "cron.scratch.get": scratch,
      "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
    },
  });
  await page.goto(`${suite.server.baseUrl}cron`);
  const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
  await row.waitFor();
  await row.locator(".cron-table__name-text").click();
  return gateway;
}

suite.define(() => {
  it.each([
    ["loads authorized automation scratch on demand without sending a write", false],
    ["does not request admin-only scratch for a read-only operator", true],
  ] as const)("%s", async (_name, readOnly) => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        ...(!readOnly && {
          recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1_280 } },
        }),
      },
      async ({ page }) => {
        const gateway = await openAutomation(page, readOnly);
        const editor = page.locator("openclaw-cron-scratch-editor");
        expect(await gateway.getRequests("cron.scratch.get")).toEqual([]);
        if (readOnly) {
          expect(await editor.count()).toBe(0);
        } else {
          await editor.locator("summary").click();
          await editor.getByRole("button", { name: "Load scratch", exact: true }).click();
          await expect.poll(() => editor.locator("textarea").inputValue()).toBe(scratchContent);
        }
        expect((await gateway.getRequests("cron.scratch.get")).map(({ params }) => params)).toEqual(
          readOnly ? [] : [{ id: job.id }],
        );
        for (const method of ["cron.add", "cron.update", "cron.scratch.set"]) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
        if (!readOnly) {
          const scratch = editor.locator("textarea");
          expect(await scratch.isEditable()).toBe(true);
          await scratch.scrollIntoViewIfNeeded();
          await writeFile(
            path.join(suite.artifactDir, "automation-scratch.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".cron-page"), [scratch]),
          );
        }
      },
    );
  });

  it("shows a scratch read failure instead of an empty success state", async () => {
    const errorMessage = "Automation scratch is temporarily unavailable.";
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await openAutomation(page, false, {
        __mockError: { code: "UNAVAILABLE", message: errorMessage },
      });
      const editor = page.locator("openclaw-cron-scratch-editor");
      await editor.locator("summary").click();
      await editor.getByRole("button", { name: "Load scratch", exact: true }).click();
      await expect.poll(() => editor.getByRole("status").textContent()).toContain(errorMessage);
    });
  });
});
