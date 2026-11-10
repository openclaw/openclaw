import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { configResponse } from "../../e2e/appearance-prefs.test-support.ts";
import {
  controlUiE2eBuiltModuleRequest,
  failControlUiModuleForDocuments,
} from "../../e2e/control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Automation run transcripts",
  startServerBeforeBrowser: true,
});
const entry = {
  jobId: "job",
  jobName: "Daily report",
  action: "finished",
  status: "ok",
  ts: Date.UTC(2026, 0, 2, 9, 5),
  runAtMs: Date.UTC(2026, 0, 2, 9),
};
const conversationScope =
  "This is the conversation used by the selected run. Shared conversations can include messages from before and after that run.";
const message = (content: string, role = "assistant") => ({ role, content });
const introduction = { ...message("Shared input"), __openclaw: { id: "introduction" } };
const pagination = { offset: 0, limit: 50, hasMore: false, nextOffset: null };
const cron = {
  "cron.list": { jobs: [], snapshotRevision: "run-proof", total: 0, ...pagination },
  "cron.runs": { entries: [entry], total: 1, ...pagination },
  "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
};
const buttonNamed = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const exactText = (root: Page | Locator, text: string) => root.getByText(text, { exact: true });
const transcriptRegion = (page: Page) =>
  page.getByRole("region", { name: "Conversation", exact: true });
const history = (content: string) => ({ messages: [message(content)] });
const historyPage = (messages: unknown[]) => ({ messages, nextCursor: "older" });
const runResponse = (overrides: Partial<CronRunLogEntry>) => ({
  ...cron["cron.runs"],
  entries: [{ ...entry, ...overrides }],
});
async function installCron(page: Page, methodResponses: Record<string, unknown>) {
  const gateway = await installMockGateway(page, {
    methodResponses: { ...cron, ...methodResponses },
  });
  await page.goto(`${suite.server.baseUrl}cron`);
  return gateway;
}
async function openRunHistory(page: Page) {
  await page.getByRole("tab", { name: "Activity history", exact: true }).click();
  const button = buttonNamed(page.locator(".cron-run-entry"), "View transcript");
  await button.click();
  return { button, region: transcriptRegion(page) };
}

suite.define(() => {
  it("opens and focuses the transcript region while its feed loads", async () => {
    await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
      const heldHistory = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/cron/run-transcript.runtime.ts"),
      );
      const held = await holdModuleResponse(
        page,
        controlUiE2eBuiltModuleRequest(
          "ui/src/pages/chat/components/chat-transcript-feed-view.tsx",
        ),
      );
      try {
        await installCron(page, { "cron.history": history("Delayed transcript output") });
        await page.getByRole("tab", { name: "Activity history", exact: true }).waitFor();
        expect(heldHistory.requests()).toBe(0);
        expect(held.requests()).toBe(0);
        const { button, region } = await openRunHistory(page);
        await heldHistory.request;
        await region.getByRole("status").first().waitFor();
        heldHistory.release();
        await held.request;
        await region.getByRole("status").first().waitFor();
        await expect
          .poll(() => region.evaluate((element) => element === document.activeElement))
          .toBe(true);
        expect(await exactText(region, conversationScope).count()).toBe(1);
        expect(await exactText(region, entry.jobName).count()).toBe(1);
        const original = await region.elementHandle();
        held.release();
        await exactText(region, "Delayed transcript output").waitFor();
        expect(
          await original?.evaluate(
            (element) => element === document.querySelector("[data-cron-run-transcript]"),
          ),
        ).toBe(true);
        await buttonNamed(region, "Close").click();
        expect(await region.count()).toBe(0);
        expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
      } finally {
        heldHistory.release();
        held.release();
      }
    });
  });

  it.each([
    ["feed", "ui/src/pages/chat/components/chat-transcript-feed-view.tsx"],
    ["history processing", "ui/src/pages/cron/run-transcript.runtime.ts"],
  ])("recovers a failed %s import through the guarded document reload", async (_name, module) => {
    await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
      const transcriptModule = controlUiE2eBuiltModuleRequest(module);
      const failed = await failControlUiModuleForDocuments(page, transcriptModule);
      const gateway = await installCron(page, {
        "cron.history": history("Recovered transcript output"),
      });
      const reload = page.waitForEvent("framenavigated", {
        predicate: (frame) =>
          frame === page.mainFrame() && frame.url().includes("openclaw_mount_recovery="),
      });
      await openRunHistory(page);
      await reload;
      const { button, region } = await openRunHistory(page);
      await exactText(region, "Recovered transcript output").waitFor();
      expect(failed.documentCount()).toBe(2);
      expect((await gateway.getRequests("cron.history")).map(({ params }) => params)).toEqual([
        { id: entry.jobId, runAtMs: entry.runAtMs, limit: 100 },
      ]);
      await buttonNamed(region, "Close").click();
      expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
    });
  });

  it("opens and pages the exact recorded run using runId", async () => {
    await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
      const identity = { id: entry.jobId, runId: "recorded-run", limit: 100 };
      const earlier = { ...identity, cursor: "older" };
      const currentPage = historyPage([introduction, message("A later run in this conversation")]);
      const earlierPage = historyPage([message("Earlier prompt", "user"), introduction]);
      const gateway = await installCron(page, {
        "cron.runs": runResponse({ runId: identity.runId, sessionKey: undefined }),
        "cron.history": {
          cases: [
            { match: earlier, response: earlierPage },
            { match: identity, response: currentPage },
          ],
        },
      });
      const { button, region } = await openRunHistory(page);
      const output = exactText(region, "A later run in this conversation");
      await output.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifacts = createControlUiE2eArtifactDir("cron-conversation-transcript");
        const frame = await takeControlUiScreenshotFrame(page, region, [output], {
          viewport: { width: 1280, height: 900 },
          animations: "disabled",
          scrollTo: region,
        });
        await writeFile(path.join(artifacts, "conversation-transcript.png"), frame.png);
      }
      expect(await exactText(region, conversationScope).count()).toBe(1);
      expect(await exactText(region, entry.jobName).count()).toBe(1);
      await gateway.deferNext("cron.history", earlier);
      await region.getByRole("button", { name: /Show earlier/ }).click();
      await gateway.waitForRequest("cron.history", { match: { cursor: "older" } });
      const failure = { code: "UNAVAILABLE", message: "Earlier page temporarily unavailable" };
      await gateway.rejectDeferred("cron.history", failure);
      await region.getByRole("alert").waitFor();
      expect(await output.count()).toBe(1);
      await buttonNamed(region, "Retry").click();
      await exactText(region, "Earlier prompt").waitFor();
      expect(await region.getByRole("button", { name: /Show earlier/ }).count()).toBe(0);
      expect(await exactText(region, introduction.content).count()).toBe(1);
      const requests = (await gateway.getRequests("cron.history")).map(({ params }) => params);
      expect(requests).toEqual([identity, earlier, earlier]);
      expect(
        (await gateway.getRequests()).filter(({ method }) => method.startsWith("tasks.")),
      ).toEqual([]);
      await buttonNamed(region, "Close").click();
      expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
      await gateway.deferNext("cron.history", identity);
      await button.click();
      await expect.poll(async () => (await gateway.getRequests("cron.history")).length).toBe(4);
      await gateway.closeLatest(1012, "Reconnect run transcript");
      await gateway.waitForRequest("cron.history", { after: 4, match: identity });
      await output.waitFor();
      await gateway.resolveDeferred("cron.history", history("Stale output"));
      expect(await exactText(page, "Stale output").count()).toBe(0);
      expect(await output.count()).toBe(1);
    });
  });

  it("uses runAtMs and retires loaded and pending transcripts when creating an automation", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installCron(page, {
        "cron.history": history("Daily report retained output"),
      });
      const { region: transcript } = await openRunHistory(page);
      const output = exactText(transcript, "Daily report retained output");
      await output.waitFor();
      expect(await gateway.getRequests("cron.history")).toMatchObject([
        { params: { id: entry.jobId, runAtMs: entry.runAtMs, limit: 100 } },
      ]);
      await gateway.setMethodResponse("cron.runs", runResponse({ summary: "Refreshed" }));
      await gateway.emitGatewayEvent("cron", { jobId: entry.jobId, action: "finished" });
      await page.locator(".cron-run-entry", { hasText: "Refreshed" }).waitFor();
      expect(await output.count()).toBe(1);
      expect(await gateway.getRequests("cron.history")).toHaveLength(1);

      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator('.cron-page[data-panel-mode="create"]').waitFor();
      expect(await transcript.count()).toBe(0);
      expect(await page.locator(".content").evaluate((element) => element.scrollTop)).toBe(0);

      await buttonNamed(page, "All automations").click();
      await gateway.deferNext("cron.history");
      await openRunHistory(page);
      await gateway.waitForRequest("cron.history", { after: 1 });
      await transcript.getByRole("status").waitFor();
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator('.cron-page[data-panel-mode="create"]').waitFor();
      expect(await transcript.count()).toBe(0);
      await gateway.resolveDeferred("cron.history", history("Retired daily report response"));
      // Mock delivery dispatches synchronously; join the page update after its request continuation.
      await page.locator("openclaw-cron-page").evaluate(async (element) => {
        await (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
      });
      expect(await transcript.count()).toBe(0);
      expect(await exactText(page, "Retired daily report response").count()).toBe(0);
    });
  });

  it("keeps missing-identity failures explicit instead of opening a session alias", async () => {
    await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
      const gateway = await installCron(page, {
        "cron.runs": runResponse({ runAtMs: undefined, sessionKey: "agent:main:main" }),
      });
      const { region } = await openRunHistory(page);
      await region.getByRole("alert").waitFor();
      expect(await exactText(region, conversationScope).count()).toBe(1);
      expect(await region.getByText("Started at", { exact: false }).count()).toBe(0);
      expect(await gateway.getRequests("cron.history")).toHaveLength(0);
      expect(new URL(page.url()).pathname).toBe("/cron");
    });
  });

  it("updates the retained run timestamp after a live locale switch", async () => {
    await suite.withPage({ locale: "de-DE", timezoneId: "UTC" }, async ({ page }) => {
      const gateway = await installCron(page, { "cron.history": history("Shared conversation") });
      await page.locator('html[lang="de"]').waitFor();
      await page.locator('[data-test-id="cron-list-tab-activity"]').click();
      await page.locator(".cron-run-entry").getByRole("button").click();
      const region = page.locator("[data-cron-run-transcript]");
      await exactText(region, "Shared conversation").waitFor();
      expect(await exactText(region, entry.jobName).count()).toBe(1);
      expect(await region.textContent()).toContain("2.1.2026, 9:00");
      const retained = await region.elementHandle();
      await gateway.setMethodResponse("config.get", configResponse({ locale: "en" }, "cron-en"));
      await gateway.emitGatewayEvent("config.changed", { hash: "cron-en" });
      await page.locator('html[lang="en"]').waitFor();
      await expect.poll(() => region.textContent()).toContain("1/2/2026, 9:00 AM");
      expect(
        await retained?.evaluate(
          (element) => element === document.querySelector("[data-cron-run-transcript]"),
        ),
      ).toBe(true);
      expect(await exactText(region, entry.jobName).count()).toBe(1);
      expect(await gateway.getRequests("cron.history")).toMatchObject([
        { params: { id: entry.jobId, runAtMs: entry.runAtMs, limit: 100 } },
      ]);
    });
  });
});
