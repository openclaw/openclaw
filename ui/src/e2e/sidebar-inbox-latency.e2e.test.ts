import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createSidebarCustomizationSuite } from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI Inbox opening latency");

async function expectInboxOnNextFrame(page: Page, populated: boolean) {
  const frame = await page.locator(".sidebar-issues-button").evaluate(
    (button) =>
      new Promise<{ visible: boolean; hasItem: boolean; hasSkeleton: boolean }>((resolve) => {
        // Start at a frame boundary so host scheduling cannot turn a paint
        // contract into a wall-clock timeout on shared CI runners.
        requestAnimationFrame(() => {
          (button as HTMLButtonElement).click();
          requestAnimationFrame(() => {
            const panel = document.querySelector<HTMLElement>("#sidebar-issues-panel");
            const style = panel && getComputedStyle(panel);
            resolve({
              visible: Boolean(
                panel &&
                panel.getBoundingClientRect().height > 0 &&
                style?.visibility === "visible" &&
                style.opacity === "1",
              ),
              hasItem: Boolean(panel?.querySelector('[data-attention-kind="cronFailed"]')),
              hasSkeleton: Boolean(panel?.querySelector('[class*="skeleton"]')),
            });
          });
        });
      }),
  );
  expect(frame).toEqual({ visible: true, hasItem: populated, hasSkeleton: false });
  if (!populated) {
    await page.locator(".sidebar-issues-panel__empty").waitFor();
  }
  await page.keyboard.press("Escape");
  await page.locator("#sidebar-issues-panel").waitFor({ state: "detached" });
}

suite.define(() => {
  it.each([false, true])("opens loaded Inbox on the next frame (items: %s)", async (populated) => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      reducedMotion: populated ? "no-preference" : "reduce",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const jobs = populated
      ? [
          {
            id: "inbox-latency-job",
            name: "Daily report",
            enabled: true,
            createdAtMs: 0,
            updatedAtMs: 0,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "Prepare the report." },
            state: { lastRunStatus: "error", lastError: "Report failed" },
          },
        ]
      : [];
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse(),
        "cron.list": {
          jobs,
          snapshotRevision: "inbox-latency",
          total: jobs.length,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        },
        "models.authStatus": { ts: 1, providers: [] },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("cron.list");
      await page.locator(".sidebar-issues-button").waitFor();
      await page.waitForLoadState("networkidle");
      await expectInboxOnNextFrame(page, populated);
      await expectInboxOnNextFrame(page, populated);

      await page.locator(".sidebar-recent-session__link").first().click();
      await page.getByRole("textbox", { name: "Chat composer", exact: true }).waitFor();
      await expectInboxOnNextFrame(page, populated);

      const connections = await gateway.getRequests("connect");
      await gateway.closeLatest();
      await gateway.waitForRequest("connect", { after: connections.length });
      await page.locator(".sidebar-issues-button").waitFor();
      await expectInboxOnNextFrame(page, populated);

      const reads = await gateway.getRequests("cron.list");
      await gateway.deferNext("cron.list");
      await gateway.emitGatewayEvent("cron", { action: "finished" });
      await gateway.waitForRequest("cron.list", { after: reads.length });
      await expectInboxOnNextFrame(page, populated);
      await gateway.resolveDeferred("cron.list");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
