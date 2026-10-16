import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  captureUiProofEnabled,
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
function job(id = "ci", overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: "Check CI and comments",
    agentId: "main",
    sessionKey: key,
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
function inventory(
  jobs: CronJob[],
  overrides: Partial<CronJobsListResult> = {},
): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "inspection-1",
    total: jobs.length,
    limit: 20,
    offset: 0,
    nextOffset: null,
    hasMore: false,
    ...overrides,
  };
}
async function fixture(page: Page, jobs: CronJob[], width: number, deferred = false) {
  await page.clock.setFixedTime(NOW);
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    featureMethods: ["progressCard.get", "cron.list"],
    ...(deferred
      ? {
          deferredRequests: [{ method: "cron.list", match: { sessionKey: key } }],
        }
      : {}),
    methodResponses: {
      "progressCard.get": { card: null },
      "cron.list": cronListResponseFixture(inventory(jobs)),
      "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
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
  if (width < 560) {
    await page
      .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
      .first()
      .click();
  }
  const link = page.locator(
    '.sidebar-recent-session[data-session-key="' + key + '"] .sidebar-recent-session__link',
  );
  await link.focus();
  const card = page.locator(".session-progress-hovercard");
  await card.waitFor({ state: "visible" });
  return {
    gateway,
    link,
    card,
    trigger: card.locator(".session-hovercard__automation-link"),
    flyout: card.locator(".session-hovercard__automations"),
  };
}
suite.define(() => {
  it.each([1440, 390])(
    "inspects a named automation and keeps native keyboard navigation at %i pixels",
    async (width) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 900 } },
        async ({ page }) => {
          const { gateway, link, card, trigger, flyout } = await fixture(page, [job()], width);
          await expect.poll(() => trigger.textContent()).toBe("Check CI and comments");
          await trigger.hover();
          await flyout.waitFor({ state: "visible" });
          await flyout.hover();
          await expect.poll(() => flyout.isVisible()).toBe(true);
          expect(await flyout.textContent()).toContain("Every 5m");
          expect(await flyout.textContent()).toContain("Last run succeeded");
          expect(await flyout.textContent()).toContain("Next");
          expect(await flyout.locator(".session-hovercard__automation-preview").textContent()).toBe(
            prompt,
          );
          if (captureUiProofEnabled) {
            const frame = await takeControlUiScreenshotFrame(page, card, [trigger, flyout], {
              animations: "disabled",
              elements: [card],
            });
            await writeFile(
              path.join(suite.artifactDir, "after-" + width + ".png"),
              frame.elements[0]!.png,
            );
            await writeFile(
              path.join(suite.artifactDir, "after-context-" + width + ".png"),
              frame.png,
            );
          }
          await trigger.click();
          await page.mouse.move(width - 5, 10);
          await flyout.waitFor({ state: "visible" });
          const summary = flyout.locator("summary");
          await summary.click();
          expect(await flyout.locator("pre").textContent()).toBe(prompt);
          await summary.focus();
          await page.keyboard.press("Escape");
          await flyout.waitFor({ state: "hidden" });
          expect(await card.isVisible()).toBe(true);
          await page.keyboard.press("Enter");
          await flyout.waitFor({ state: "visible" });
          await page.keyboard.press("Tab");
          await flyout.waitFor({ state: "visible" });
          expect(await summary.evaluate((el) => el === document.activeElement)).toBe(true);
          const open = flyout.getByRole("link", { name: "Open automation", exact: true });
          expect(await open.getAttribute("href")).toContain("job=ci");
          expect(
            (await gateway.getRequests("cron.list")).filter((request) => {
              const p = requireRecord(request.params);
              return p.sessionKey === key && p.compact !== true;
            }).length,
          ).toBe(1);
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
          await card.waitFor({ state: "detached" });
          expect(await link.evaluate((el) => el === document.activeElement)).toBe(true);
          // Escape returns to the sidebar; a new hover explicitly re-enters the dismissed card.
          await link.hover();
          await trigger.hover();
          await flyout.waitFor({ state: "visible" });
          await flyout.getByRole("link", { name: "Open automation", exact: true }).click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/automations");
          expect(new URL(page.url()).searchParams.get("job")).toBe("ci");
          expect(new URL(page.url()).searchParams.get("session")).toBe(key);
        },
      );
    },
  );
  it("switches attached jobs and refreshes runtime state without changing automation settings", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const paused = job("merge", {
          name: "Merge when ready",
          enabled: false,
          payload: {
            kind: "agentTurn",
            message: "Merge only after required checks and reviews pass.",
          },
          state: {
            lastRunAtMs: NOW - 180_000,
            lastRunStatus: "error",
            lastError: "Required review is missing.",
          },
        });
        const { gateway, card, trigger, flyout } = await fixture(page, [job(), paused], 1440);
        await expect.poll(() => trigger.textContent()).toBe("2 automations");
        await trigger.hover();
        await flyout.waitFor({ state: "visible" });
        await flyout.getByRole("button", { name: "Merge when ready Paused" }).click();
        expect(await flyout.locator(".session-hovercard__automation-name").textContent()).toBe(
          "Merge when ready",
        );
        expect(await flyout.textContent()).toContain("Last run failed");
        expect(await flyout.textContent()).toContain("Required review is missing.");
        expect(
          await flyout
            .getByRole("link", { name: "Open automation", exact: true })
            .getAttribute("href"),
        ).toContain("job=merge");
        await gateway.setMethodResponse(
          "cron.list",
          cronListResponseFixture(
            inventory([job(), { ...paused, enabled: true, state: { runningAtMs: NOW } }], {
              snapshotRevision: "inspection-2",
            }),
          ),
        );
        await gateway.emitGatewayEvent("cron", { jobId: "merge", action: "started" });
        await expect
          .poll(() => flyout.locator('[data-running="true"]').textContent())
          .toBe("Running");
        expect(await flyout.locator(".session-hovercard__automation-name").textContent()).toBe(
          "Merge when ready",
        );
        const writes = (await gateway.getRequests()).filter((r) =>
          ["cron.add", "cron.update", "cron.remove", "cron.run"].includes(r.method),
        );
        expect(writes).toEqual([]);
        expect(await card.isVisible()).toBe(true);
      },
    );
  });
  it("recovers a failed scoped read, paginates jobs, and reports removal explicitly", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const { gateway, trigger, flyout } = await fixture(page, [job()], 1440, true);
        await trigger.hover();
        await flyout.getByRole("status").getByText("Loading automations…").waitFor();
        await gateway.rejectDeferred(
          "cron.list",
          { message: "Read unavailable" },
          { match: { sessionKey: key } },
        );
        await flyout.getByText("Couldn't load automations.").waitFor();
        await gateway.setMethodResponse(
          "cron.list",
          cronListResponseFixture(
            inventory([job()], { limit: 1, total: 2, hasMore: true, nextOffset: 1 }),
          ),
        );
        await flyout.getByRole("button", { name: "Retry", exact: true }).click();
        await expect.poll(() => trigger.textContent()).toBe("2 automations");
        const command = job("command", {
          name: "Run repository check",
          payload: { kind: "command", argv: ["git", "status", "--short"] },
        });
        await gateway.setMethodResponse(
          "cron.list",
          cronListResponseFixture(inventory([command], { offset: 1, limit: 1, total: 2 })),
        );
        await flyout.getByRole("button", { name: "Load more automations" }).click();
        await flyout.getByRole("button", { name: "Run repository check Enabled" }).click();
        expect(await flyout.locator(".session-hovercard__automation-preview").textContent()).toBe(
          "git status --short",
        );
        await gateway.setMethodResponse(
          "cron.list",
          cronListResponseFixture(inventory([], { snapshotRevision: "empty" })),
        );
        await gateway.emitGatewayEvent("cron", { jobId: "command", action: "removed" });
        await flyout.getByText("No automations for this session").waitFor();
        expect(
          await flyout
            .getByRole("link", { name: "Open automations", exact: true })
            .getAttribute("href"),
        ).toContain("session=agent%3Amain%3Aautomation-preview");
      },
    );
  });
});
