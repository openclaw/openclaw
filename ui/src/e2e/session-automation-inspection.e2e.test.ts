import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const key = "agent:main:automation-preview";
const NOW = Date.parse("2026-10-14T06:00:00Z");
const prompt =
  "Check the linked PR for failed checks and unresolved review comments. Fix actionable issues and verify the changes.\nFollow the repository’s review and test workflow. Recheck current state before making changes. Report blockers in the originating session; do not bypass required checks or reviews.";
const withPage = (run: Parameters<typeof suite.withPage>[1], width = 1440) =>
  suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 900 } },
    run,
  );
const openLink = (flyout: Locator) =>
  flyout.getByRole("link", { name: "Open automation", exact: true });
const detail = (flyout: Locator, part: "preview" | "name") =>
  flyout.locator(`.session-hovercard__automation-${part}`).textContent();
function job(id = "ci", overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: "Check CI and comments",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 300_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: prompt },
    state: {
      nextRunAtMs: NOW + 120_000,
      lastRunAtMs: NOW - 180_000,
      lastRunStatus: "ok",
    },
    ...overrides,
  };
}
function inventory(jobs: CronJob[], overrides: Partial<CronJobsListResult> = {}) {
  return cronListResponseFixture({
    jobs,
    snapshotRevision: "inspection-1",
    total: jobs.length,
    limit: 20,
    offset: 0,
    nextOffset: null,
    hasMore: false,
    ...overrides,
  });
}
async function installSessionFixture(page: Page, jobs: CronJob[]) {
  await page.clock.setFixedTime(NOW);
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    featureMethods: ["progressCard.get", "cron.list"],
    methodResponses: {
      "progressCard.get": { card: null },
      "cron.list": inventory(jobs),
      "cron.get": { cases: jobs.map((value) => ({ match: { id: value.id }, response: value })) },
      "sessions.list": chatSessionListResponse([
        {
          key,
          kind: "direct",
          label: "Refresh versus retry distinction",
          hasAutomation: true,
          updatedAt: 1,
        },
      ]),
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  return gateway;
}
async function fixture(page: Page, jobs: CronJob[], width = 1440) {
  const gateway = await installSessionFixture(page, jobs);
  if (width < 560) {
    await navigationDrawerToggle(page).click();
  }
  const link = page.locator(
    '.sidebar-recent-session[data-session-key="' + key + '"] .sidebar-recent-session__link',
  );
  await link.focus();
  const card = page.locator(".session-progress-hovercard");
  await card.waitFor({ state: "visible" });
  return {
    gateway,
    card,
    trigger: card.locator(".session-hovercard__automation-link"),
    flyout: card.locator(".session-hovercard__automations"),
    setJobs: (nextJobs: CronJob[], overrides: Partial<CronJobsListResult> = {}) =>
      gateway.setMethodResponse("cron.list", inventory(nextJobs, overrides)),
  };
}
suite.define(() => {
  it.each([
    { width: 1440, entry: "desktop" },
    { width: 390, entry: "single" },
    { width: 390, entry: "list" },
  ])("opens the selected automation page from $entry Details", async ({ width, entry }) => {
    await withPage(async ({ page }) => {
      const selected = job("release + review", { name: "Release review" });
      const jobs = entry === "single" ? [selected] : [job(), selected];
      const gateway = await installSessionFixture(page, jobs);
      const details = await openChatDetails(page);
      const automations = details.locator('[data-details-group="automations"]');
      if (entry === "desktop") {
        await automations.getByRole("link", { name: /Release review/ }).click();
      } else if (entry === "single") {
        await automations.getByRole("button", { name: /Release review/ }).click();
      } else {
        await automations.locator('[data-details-destination="automations"]').click();
        await details.getByRole("link", { name: /Release review/ }).click();
      }
      await page.waitForURL((url) => url.pathname === "/automations");
      expect(new URL(page.url()).searchParams.get("job")).toBe(selected.id);
      await page.locator(".cron-detail-title").getByText(selected.name, { exact: true }).waitFor();
      expect((await gateway.getRequests("cron.get")).map(({ params }) => params)).toContainEqual({
        id: selected.id,
      });
      expect(await page.locator(".chat-mobile-host").filter({ visible: true }).count()).toBe(0);
    }, width);
  });
  it.each([1440, 390])("inspects and opens a named automation at %i pixels", async (width) => {
    await withPage(async ({ page }) => {
      const { gateway, trigger, flyout } = await fixture(page, [job()], width);
      await expect.poll(() => trigger.textContent()).toBe("Check CI and comments");
      await trigger.hover();
      await flyout.waitFor({ state: "visible" });
      expect(
        await trigger.evaluate((element) => getComputedStyle(element).textDecorationLine),
      ).toBe("none");
      expect(
        await trigger.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).paddingTop),
        ),
      ).toBeGreaterThanOrEqual(4);
      expect(
        await trigger.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).paddingBottom),
        ),
      ).toBeGreaterThanOrEqual(4);
      await flyout.hover();
      await expect.poll(() => flyout.isVisible()).toBe(true);
      expect(await flyout.textContent()).toContain("Last run succeeded");
      expect(await flyout.textContent()).toContain("Next");
      expect(await detail(flyout, "preview")).toBe(prompt);
      await page.keyboard.press("Tab");
      await trigger.focus();
      await page.mouse.move(width - 5, 10);
      expect(await trigger.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
      expect(
        await trigger.evaluate((element) => getComputedStyle(element).textDecorationLine),
      ).toBe("none");
      await trigger.click();
      await page.mouse.move(width - 5, 10);
      await flyout.waitFor({ state: "visible" });
      const reads = await gateway.getRequests("cron.list", { sessionKey: key });
      expect(reads.filter(({ params }) => requireRecord(params).compact !== true)).toHaveLength(1);
      await openLink(flyout).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/automations");
      expect(new URL(page.url()).searchParams.get("job")).toBe("ci");
      expect(new URL(page.url()).searchParams.get("session")).toBe(key);
    }, width);
  });
  it("switches attached jobs and refreshes runtime state without changing automation settings", async () => {
    await withPage(async ({ page }) => {
      const paused = job("merge", {
        name: "Merge when ready",
        enabled: false,
        state: {
          lastRunAtMs: NOW - 180_000,
          lastRunStatus: "error",
          lastError: "Required review is missing.",
        },
      });
      const { gateway, card, trigger, flyout, setJobs } = await fixture(page, [job(), paused]);
      await expect.poll(() => trigger.textContent()).toBe("2 automations");
      await trigger.hover();
      await flyout.waitFor({ state: "visible" });
      await flyout.getByRole("button", { name: "Merge when ready Paused" }).click();
      expect(await detail(flyout, "name")).toBe("Merge when ready");
      expect(await flyout.textContent()).toContain("Last run failed");
      expect(await flyout.textContent()).toContain("Required review is missing.");
      expect(await openLink(flyout).getAttribute("href")).toContain("job=merge");
      await setJobs([job(), { ...paused, enabled: true, state: { runningAtMs: NOW } }], {
        snapshotRevision: "inspection-2",
      });
      await gateway.emitGatewayEvent("cron", { jobId: "merge", action: "started" });
      await expect
        .poll(() => flyout.locator('[data-running="true"]').textContent())
        .toBe("Running");
      expect(await detail(flyout, "name")).toBe("Merge when ready");
      const writes = (await gateway.getRequests()).filter((r) =>
        ["cron.add", "cron.update", "cron.remove", "cron.run"].includes(r.method),
      );
      expect(writes).toEqual([]);
      expect(await card.isVisible()).toBe(true);
    });
  });
  it("previews a command and reports removal explicitly", async () => {
    await withPage(async ({ page }) => {
      const command = job("command", {
        name: "Run repository check",
        payload: { kind: "command", argv: ["git", "status", "--short"] },
      });
      const { gateway, trigger, flyout, setJobs } = await fixture(page, [job(), command]);
      await trigger.hover();
      await flyout.waitFor();
      await flyout.getByRole("button", { name: "Run repository check Enabled" }).click();
      expect(await detail(flyout, "preview")).toBe("git status --short");
      await setJobs([], { snapshotRevision: "empty" });
      await gateway.emitGatewayEvent("cron", { jobId: "command", action: "removed" });
      await flyout.getByText("No automations for this session").waitFor();
      expect(
        await flyout
          .getByRole("link", { name: "Open automations", exact: true })
          .getAttribute("href"),
      ).toContain("session=agent%3Amain%3Aautomation-preview");
    });
  });
});
