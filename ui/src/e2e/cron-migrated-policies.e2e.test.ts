import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob, CronScratchGetResult } from "../api/types.ts";
import { createCronJob, cronJobsListResponse } from "../lib/cron/cron.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI migrated automation policies" });
const initialScratch = "# Evening checklist\n\n- Inspect queued work.\n";
const editedScratch = "# Evening checklist\n\n- Inspect queued work.\n- Report blocked tasks.\n";

const mainJob = createCronJob("evening-checklist", "Evening checklist", {
  enabled: false,
  description: "Synthetic migrated automation for the shared main conversation.",
  configRevision: "main-definition-1",
  schedule: { kind: "every", everyMs: 1_800_000 },
  sessionTarget: "main",
  wakeMode: "now",
  activeHours: { start: "22:00", end: "06:00", timezone: "UTC" },
  idleOnly: true,
  payload: {
    kind: "agentTurn",
    message: "Review the saved checklist and report meaningful changes.",
    skipIfScratchEmpty: true,
    includeReasoning: true,
  },
  delivery: { mode: "announce", target: "owner", directPolicy: "allow", channel: "telegram" },
});
const ownerJob = createCronJob("owner-digest", "Owner digest", {
  enabled: false,
  description: "Synthetic migrated automation with a direct owner destination.",
  configRevision: "owner-definition-1",
  schedule: { kind: "every", everyMs: 3_600_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Share the overnight summary with the owner." },
  delivery: { mode: "announce", target: "owner", directPolicy: "allow", channel: "telegram" },
});

const scratch = (content: string, revision: number): CronScratchGetResult => ({
  scratch: { content, revision, updatedAtMs: 1_800_000_000_000 },
  currentRevision: revision,
  maxBytes: 262_144,
});

async function capture(page: Page, stage: string, target: Locator) {
  const frame = await takeControlUiScreenshotFrame(page, page.locator(".cron-page"), [target], {
    animations: "disabled",
    scrollTo: target,
    elements: [target],
  });
  await writeFile(path.join(suite.artifactDir, `${stage}.png`), frame.png);
  await writeFile(path.join(suite.artifactDir, `${stage}-control.png`), frame.elements[0]!.png);
}

async function openJob(page: Page, job: CronJob) {
  await page.locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name-text`).click();
  await page.locator("#cron-payload-text").waitFor();
}

suite.define(() => {
  it.each([
    { name: "desktop", viewport: { width: 1280, height: 900 } },
    { name: "narrow", viewport: { width: 390, height: 844 } },
  ])(
    "edits migrated main policies and revision-owned scratch on $name",
    async ({ name, viewport }) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            communityInvite: false,
            methodResponses: {
              "cron.list": cronListResponseFixture(cronJobsListResponse([mainJob, ownerJob])),
              "cron.get": {
                cases: [
                  { match: { id: mainJob.id }, response: mainJob },
                  { match: { id: ownerJob.id }, response: ownerJob },
                ],
              },
              "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
              "cron.status": { enabled: true, jobs: 2, nextWakeAtMs: null },
              "cron.scratch.get": scratch(initialScratch, 7),
            },
          });
          await page.goto(`${suite.server.baseUrl}cron`);
          await openJob(page, mainJob);
          const prompt = page.locator("#cron-payload-text");
          await expect
            .poll(() => prompt.inputValue())
            .toBe("Review the saved checklist and report meaningful changes.");
          expect(await prompt.isEditable()).toBe(true);
          await capture(page, `${name}-main-agent-turn`, prompt);
          const delivery = page.locator("#cron-delivery-mode");
          await capture(page, `${name}-main-announce-delivery`, delivery);
          expect(await delivery.textContent()).toContain("Announce");
          expect(await page.locator("#cron-delivery-target").textContent()).toContain(
            "Owner direct message",
          );
          await page.locator("details.cron-advanced > summary").click();
          const end = page.locator("#cron-active-hours-end");
          await expect.poll(() => end.inputValue()).toBe("06:00");
          for (const label of ["Wait until idle", "Skip empty scratch", "Include reasoning"]) {
            expect(await page.getByRole("switch", { name: label, exact: true }).isChecked()).toBe(
              true,
            );
          }
          await end.fill("07:00");
          await page.getByRole("switch", { name: "Wait until idle", exact: true }).uncheck();
          const updateAfter = await gateway.deferNext("cron.update");
          await page.locator('[data-test-id="cron-submit"]').click();
          const update = await gateway.waitForRequest("cron.update", { after: updateAfter });
          expect(update.params).toMatchObject({
            id: mainJob.id,
            expectedConfigRevision: mainJob.configRevision,
            patch: {
              sessionTarget: "main",
              delivery: mainJob.delivery,
              activeHours: { start: "22:00", end: "07:00", timezone: "UTC" },
              idleOnly: false,
              payload: {
                kind: "agentTurn",
                message: "Review the saved checklist and report meaningful changes.",
                skipIfScratchEmpty: true,
                includeReasoning: true,
              },
            },
          });
          // The response mirrors only the independently asserted changes.
          const updatedJob: CronJob = {
            ...mainJob,
            configRevision: "main-definition-2",
            activeHours: { start: "22:00", end: "07:00", timezone: "UTC" },
            idleOnly: false,
          };
          await gateway.setMethodResponse(
            "cron.list",
            cronListResponseFixture(cronJobsListResponse([updatedJob, ownerJob])),
          );
          await gateway.setMethodResponse("cron.get", {
            cases: [
              { match: { id: mainJob.id }, response: updatedJob },
              { match: { id: ownerJob.id }, response: ownerJob },
            ],
          });
          await gateway.resolveDeferred("cron.update", updatedJob);
          await expect
            .poll(() => page.locator('[data-test-id="cron-submit"]').isDisabled())
            .toBe(false);
          await capture(page, `${name}-active-hours`, page.locator("#cron-active-hours-start"));
          await capture(
            page,
            `${name}-reasoning-policy`,
            page.locator(".settings-row--toggle").filter({
              has: page.getByRole("switch", { name: "Include reasoning", exact: true }),
            }),
          );

          const scratchEditor = page.locator("openclaw-cron-scratch-editor");
          expect(await gateway.getRequests("cron.scratch.get")).toEqual([]);
          await scratchEditor.locator("summary").click();
          await scratchEditor.getByRole("button", { name: "Load scratch", exact: true }).click();
          const notes = scratchEditor.locator("textarea");
          await expect.poll(() => notes.inputValue()).toBe(initialScratch);
          expect(
            (await gateway.getRequests("cron.scratch.get")).map(({ params }) => params),
          ).toEqual([{ id: mainJob.id }]);
          await notes.fill(editedScratch);
          const saveAfter = await gateway.deferNext("cron.scratch.set");
          await scratchEditor.getByRole("button", { name: "Save scratch", exact: true }).click();
          const saved = await gateway.waitForRequest("cron.scratch.set", { after: saveAfter });
          expect(saved.params).toEqual({
            id: mainJob.id,
            content: editedScratch,
            expectedRevision: 7,
          });
          await gateway.setMethodResponse("cron.scratch.get", scratch(editedScratch, 8));
          await gateway.resolveDeferred("cron.scratch.set", {
            ok: true,
            ...scratch(editedScratch, 8),
          });
          await expect
            .poll(() => scratchEditor.getByRole("status").textContent())
            .toBe("Scratch saved.");
          await scratchEditor.getByRole("button", { name: "Reload scratch", exact: true }).click();
          await expect.poll(() => notes.inputValue()).toBe(editedScratch);
          await expect
            .poll(() =>
              scratchEditor.getByRole("button", { name: "Save scratch", exact: true }).isDisabled(),
            )
            .toBe(false);
          await capture(page, `${name}-saved-scratch`, notes);

          await page.locator('[data-test-id="cron-back"]').click();
          await openJob(page, ownerJob);
          const owner = page.locator("#cron-delivery-target");
          await expect.poll(() => owner.textContent()).toContain("Owner direct message");
          expect(await page.locator("#cron-delivery-to").count()).toBe(0);
          await capture(page, `${name}-owner-delivery`, owner);
          expect(await gateway.getRequests("cron.run")).toEqual([]);
          expect(await gateway.getRequests("cron.add")).toEqual([]);
        },
      );
    },
  );
});
