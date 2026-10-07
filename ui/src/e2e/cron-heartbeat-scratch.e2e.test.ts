import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI automation scratch" });

const job: CronJob = {
  id: "migrated-checklist",
  configRevision: "checklist-config-1",
  declarationKey: "heartbeat:main",
  name: "Evening checklist",
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 1_800_000 },
  sessionTarget: "session:agent:main:main",
  wakeMode: "next-heartbeat",
  payload: {
    kind: "agentTurn",
    message: "Check the scratch notes and report anything actionable.",
    skipIfScratchEmpty: true,
  },
  activeHours: { start: "22:00", end: "06:00", timezone: "Europe/Vienna" },
  idleOnly: true,
  delivery: { mode: "announce", target: "owner", directPolicy: "block" },
  state: {},
};

const scratchContent = "# Checklist\n\n- Inspect synthetic queued work.\n";
const scratchResponse = {
  scratch: { content: scratchContent, revision: 1, updatedAtMs: 1 },
  currentRevision: 1,
  maxBytes: 262_144,
};

function methodResponses(scratch: unknown = scratchResponse) {
  return {
    "cron.list": cronListResponseFixture({
      jobs: [job],
      snapshotRevision: "automation-scratch",
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    }),
    "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
    "cron.scratch.get": scratch,
    "cron.scratch.set": {
      ok: true,
      ...scratchResponse,
      scratch: { ...scratchResponse.scratch, content: "Updated synthetic checklist", revision: 2 },
      currentRevision: 2,
    },
    "cron.get": job,
    "cron.update": {
      ...job,
      configRevision: "checklist-config-2",
      delivery: { mode: "announce", target: "owner", directPolicy: "allow" },
    },
    "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
  };
}

suite.define(() => {
  it("edits migrated automation policies and saves scratch through its ordinary job", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
        recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1_280 } },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: methodResponses(),
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name-text`).click();
        const prompt = page.locator("#cron-payload-text");
        expect(await prompt.isEditable()).toBe(true);
        await page.locator("details.cron-advanced > summary").click();
        expect(await page.locator("#cron-active-hours-start").inputValue()).toBe("22:00");
        await page.locator("#cron-active-hours-end").fill("07:00");
        expect(await page.locator('[data-test-id="cron-submit"]').isDisabled()).toBe(true);
        await page.getByRole("button", { name: "Direct messages: Block", exact: true }).click();
        await page.getByRole("option", { name: "Allow", exact: true }).click();
        await page.locator('[data-test-id="cron-submit"]').click();
        const update = await gateway.waitForRequest("cron.update");
        expect(update.params).toMatchObject({
          id: job.id,
          expectedConfigRevision: job.configRevision,
          patch: {
            activeHours: { ...job.activeHours, end: "07:00" },
            idleOnly: true,
            payload: job.payload,
            delivery: { mode: "announce", target: "owner", directPolicy: "allow" },
          },
        });
        expect(await gateway.getRequests("cron.scratch.get")).toEqual([]);
        await page.locator("#cron-active-hours-start").scrollIntoViewIfNeeded();
        await writeFile(
          path.join(suite.artifactDir, "automation-policies.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".cron-page"), [
            page.locator("#cron-active-hours-start"),
          ]),
        );

        const scratch = page.locator("openclaw-cron-scratch-editor");
        await scratch.locator("summary").click();
        await scratch.getByRole("button", { name: "Load scratch", exact: true }).click();
        const editor = scratch.getByRole("textbox", { name: "Scratch content" });
        await expect.poll(() => editor.inputValue()).toBe(scratchContent);
        await editor.fill("Updated synthetic checklist");
        await scratch.getByRole("button", { name: "Save scratch", exact: true }).click();
        const save = await gateway.waitForRequest("cron.scratch.set");
        expect(save.params).toEqual({
          id: job.id,
          content: "Updated synthetic checklist",
          expectedRevision: 1,
        });
        await scratch.getByRole("status").filter({ hasText: "Scratch saved." }).waitFor();

        expect((await gateway.getRequests("cron.scratch.get")).map(({ params }) => params)).toEqual(
          [{ id: job.id }],
        );
        for (const method of ["cron.add", "config.set", "set-heartbeats"]) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
        await editor.scrollIntoViewIfNeeded();
        await writeFile(
          path.join(suite.artifactDir, "automation-scratch.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".cron-page"), [editor]),
        );
      },
    );
  });

  it("does not request admin-only scratch for a read-only operator", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1_280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: methodResponses(),
          operatorScopes: ["operator.read"],
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
        await row.waitFor();
        await row.locator(".cron-table__name-text").click();
        expect(await page.locator("openclaw-cron-scratch-editor").count()).toBe(0);
        expect(await gateway.getRequests("cron.scratch.get")).toEqual([]);
        for (const method of ["cron.add", "cron.update", "cron.scratch.set"]) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
      },
    );
  });

  it("shows a scratch read failure instead of an empty success state", async () => {
    const errorMessage = "Automation scratch is temporarily unavailable.";
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1_280 } },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: methodResponses({
            __mockError: { code: "UNAVAILABLE", message: errorMessage },
          }),
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name-text`).click();
        const scratch = page.locator("openclaw-cron-scratch-editor");
        await scratch.locator("summary").click();
        await scratch.getByRole("button", { name: "Load scratch", exact: true }).click();
        await expect.poll(() => scratch.getByRole("status").textContent()).toContain(errorMessage);
      },
    );
  });
});
