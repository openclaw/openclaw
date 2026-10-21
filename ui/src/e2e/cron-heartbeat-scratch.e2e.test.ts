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

const suite = createControlUiE2eSuite({ name: "Control UI heartbeat scratch" });

const job = createCronJob("heartbeat-monitor", "Heartbeat (main)", {
  schedule: { kind: "every", everyMs: 1_800_000 },
  sessionTarget: "main",
  payload: { kind: "heartbeat" },
});

const scratchContent = "# Heartbeat checklist\n\n- Inspect queued work.\n";
const scratchResponse = {
  scratch: { content: scratchContent, revision: 1, updatedAtMs: 1 },
  currentRevision: 1,
  maxBytes: 262_144,
};

async function openMonitor(page: Page, readOnly = false, scratch: unknown = scratchResponse) {
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
    ["shows authorized scratch in the read-only monitor without sending a write", false],
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
        const gateway = await openMonitor(page, readOnly);
        const monitor = page.locator("#cron-payload-text");
        await expect.poll(() => monitor.inputValue()).toBe(readOnly ? "" : scratchContent);
        expect((await gateway.getRequests("cron.scratch.get")).map(({ params }) => params)).toEqual(
          readOnly ? [] : [{ id: job.id }],
        );
        for (const method of ["cron.add", "cron.update", "cron.scratch.set"]) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
        if (!readOnly) {
          expect({
            readonly: await monitor.getAttribute("readonly"),
            editable: await monitor.isEditable(),
          }).toEqual({ readonly: "", editable: false });
          await monitor.scrollIntoViewIfNeeded();
          await writeFile(
            path.join(suite.artifactDir, "heartbeat-monitor-scratch.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".cron-page"), [monitor]),
          );
        }
      },
    );
  });

  it("shows a scratch read failure instead of an empty success state", async () => {
    const errorMessage = "Heartbeat scratch is temporarily unavailable.";
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await openMonitor(page, false, {
        __mockError: { code: "UNAVAILABLE", message: errorMessage },
      });
      await expect
        .poll(() => page.locator(".cron-error-banner").textContent())
        .toContain(errorMessage);
    });
  });
});
