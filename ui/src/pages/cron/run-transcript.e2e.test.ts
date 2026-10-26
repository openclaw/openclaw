import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { CronRunLogEntry } from "../../api/types.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Automation run transcripts",
  startServerBeforeBrowser: true,
});
const entry = { jobId: "job", action: "finished", status: "ok", ts: 1, runAtMs: 1000 };
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
  page.getByRole("region", { name: "Run transcript", exact: true });
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
  await page.getByRole("tab", { name: "Run history", exact: true }).click();
  const button = buttonNamed(page.locator(".cron-run-entry"), "View transcript");
  await button.click();
  return { button, region: transcriptRegion(page) };
}

suite.define(() => {
  it("opens and pages the exact recorded run using runId", async () => {
    await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
      const identity = { id: entry.jobId, runId: "recorded-run", limit: 100 };
      const earlier = { ...identity, cursor: "older" };
      const currentPage = historyPage([introduction, message("Exact retained output")]);
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
      const output = exactText(region, "Exact retained output");
      await output.waitFor();
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
      expect(await gateway.getRequests("cron.history")).toHaveLength(0);
      expect(new URL(page.url()).pathname).toBe("/cron");
    });
  });
});
