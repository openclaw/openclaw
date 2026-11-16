import type { Page } from "playwright";
import { expect } from "vitest";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import { cronJobsListResponse } from "../test-helpers/cron.ts";

export { createCronRunsResult as cronRuns } from "../test-helpers/cron.ts";

export function cronJob(id: string, name: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Synthetic automation" },
    state: {},
    ...overrides,
  };
}

export function cronList(
  jobs: CronJob[],
  snapshotRevision: string,
  pagination: Partial<Omit<CronJobsListResult, "jobs" | "snapshotRevision">> = {},
): CronJobsListResult {
  return cronJobsListResponse(jobs, { snapshotRevision, ...pagination });
}

/** The Automations sidebar lists automations only when the Gateway advertises cron.list. */
export const cronSidebarFeatureMethods = [...defaultControlUiFeatureMethods, "cron.list"];

/** An automation's Automations sidebar row, once listed, expanding the collapsed Paused group
    when the automation is paused. */
export async function automationRow(page: Page, id: string) {
  const row = page.locator(`.sidebar-automations a[href*="?job=${encodeURIComponent(id)}"]`);
  const collapsed = page.locator(
    '.sidebar-automations .sidebar-session-group-toggle[aria-expanded="false"]',
  );
  await expect
    .poll(
      async () => {
        if (!(await row.isVisible()) && (await collapsed.count()) > 0) {
          await collapsed.first().click();
        }
        return row.isVisible();
      },
      { timeout: 10_000 },
    )
    .toBe(true);
  return row;
}

/** Opens an automation as a person does: from its Automations sidebar row. */
export async function openAutomation(page: Page, id: string) {
  const row = await automationRow(page, id);
  const name = (await row.locator(".sidebar-automations__name").textContent())?.trim();
  await row.click();
  // The page has opened this automation once its header names it.
  await expect
    .poll(() => page.locator('.cron-page[data-panel-mode="job"] .cron-detail-title').textContent())
    .toBe(name);
  return row;
}

/** Opens every automation's runs from the Automations sidebar. */
export async function openAutomationActivity(page: Page) {
  await page.locator('.sidebar-automations a[href$="?activity"]').click();
  await page.locator('.cron-page[data-panel-mode="activity"]').waitFor({ state: "visible" });
}
