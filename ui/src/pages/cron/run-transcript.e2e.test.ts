import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../../api/types.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../../test-helpers/cron.ts";

const suite = createControlUiE2eSuite({
  name: "Automation run transcripts",
  startServerBeforeBrowser: true,
});
const entry = {
  jobId: "synthetic-job",
  action: "finished",
  status: "ok",
  ts: 2000,
  runAtMs: 1000,
  sessionKey: "agent:main:cron:synthetic-job:run:old",
  summary: "Earlier run",
};
const introduction = {
  role: "assistant",
  __openclaw: { id: "introduction" },
  senderSession: {
    sessionKey: entry.sessionKey,
    agentId: "main",
    label: "Daily report — café 雪 🦞",
  },
  content: "Check the queue and report the result.",
};
const pagination = { offset: 0, limit: 50, hasMore: false, nextOffset: null };
const cron = {
  "cron.list": { jobs: [], snapshotRevision: "run-proof", total: 0, ...pagination },
  "cron.runs": { entries: [entry], total: 1, ...pagination },
  "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
};
const buttonNamed = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const transcriptRegion = (page: Page) =>
  page.getByRole("region", { name: "Run transcript", exact: true });
const detailTab = (page: Page, tab: string) =>
  page.locator(`[data-test-id="cron-detail-tab-${tab}"]`);
const message = (content: string, role = "assistant") => ({ role, content });
const history = (content: string) => ({ messages: [message(content)] });
const historyPage = (messages: unknown[]) => ({ messages, nextCursor: "older" });
const runResponse = (overrides: Partial<typeof entry> & { runId?: string }) => ({
  ...cron["cron.runs"],
  entries: [{ ...entry, ...overrides }],
});
const installCron = (page: Page, methodResponses: Record<string, unknown>) =>
  installMockGateway(page, { methodResponses: { ...cron, ...methodResponses } });
async function openRunHistory(page: Page) {
  await page.goto(`${suite.server.baseUrl}cron`);
  await page.getByRole("tab", { name: "Run history", exact: true }).click();
  const button = buttonNamed(page.locator(".cron-run-entry"), "View transcript");
  await button.click();
  return { button, region: transcriptRegion(page) };
}

suite.define(() => {
  for (const runId of [undefined, "recorded-run"] as const) {
    it(`opens and pages the exact recorded run using ${runId ? "runId" : "runAtMs"}`, async () => {
      await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
        const identity = { id: entry.jobId, ...(runId ? { runId } : { runAtMs: entry.runAtMs }) };
        const gateway = await installCron(page, {
          "cron.runs": runResponse({ runId, sessionKey: undefined }),
          "cron.history": {
            cases: [
              {
                match: { cursor: "older" },
                response: historyPage([message("Earlier prompt", "user"), introduction]),
              },
              {
                match: identity,
                response: historyPage([introduction, message("Exact retained output")]),
              },
            ],
          },
        });
        const { button, region } = await openRunHistory(page);
        await region.getByText("Exact retained output", { exact: true }).waitFor();
        await gateway.deferNext("cron.history", { ...identity, limit: 100, cursor: "older" });
        await region.getByRole("button", { name: /Show earlier/ }).click();
        await gateway.waitForRequest("cron.history", { match: { cursor: "older" } });
        await gateway.rejectDeferred("cron.history", {
          code: "UNAVAILABLE",
          message: "Earlier page temporarily unavailable",
        });
        await region.getByRole("alert").waitFor();
        expect(await region.getByText("Exact retained output", { exact: true }).count()).toBe(1);
        await buttonNamed(region, "Retry").click();
        await region.getByText("Earlier prompt", { exact: true }).waitFor();
        expect(await region.getByRole("button", { name: /Show earlier/ }).count()).toBe(0);
        const attribution = region.locator(".chat-reply-attribution--forwarded");
        expect(await attribution.count()).toBe(1);
        expect(await attribution.textContent()).toContain("Daily report — café 雪 🦞");
        expect(await attribution.locator("a, [role=link], [tabindex]").count()).toBe(0);
        const speakerLabels = await region.locator(".sr-only").allTextContents();
        expect(speakerLabels).toEqual(["User: ", "Assistant: "]);
        const display = await attribution.evaluate((element) => getComputedStyle(element).display);
        expect(display).toBe("inline-flex");
        const proof = createControlUiE2eArtifactDir("automation-attribution");
        await page.screenshot({ path: path.join(proof, "automation-attribution.png") });
        expect(new URL(page.url()).pathname).toBe("/cron");
        expect(await gateway.getRequests("cron.history")).toMatchObject([
          { params: { ...identity, limit: 100 } },
          { params: { ...identity, limit: 100, cursor: "older" } },
          { params: { ...identity, limit: 100, cursor: "older" } },
        ]);
        for (const request of await gateway.getRequests("cron.history")) {
          expect(request.params).not.toHaveProperty("sessionKey");
        }
        for (const method of ["tasks.list", "tasks.get", "tasks.history"]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
        await buttonNamed(region, "Close").click();
        expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
        await gateway.deferNext("cron.history", { ...identity, limit: 100 });
        await button.click();
        await expect.poll(async () => (await gateway.getRequests("cron.history")).length).toBe(4);
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1012, "Reconnect run transcript");
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await gateway.waitForRequest("cron.history", { after: 4, match: identity });
        await region.getByText("Exact retained output", { exact: true }).waitFor();
        await gateway.resolveDeferred("cron.history", history("Stale output"));
        expect(await page.getByText("Stale output", { exact: true }).count()).toBe(0);
        expect(await region.getByText("Exact retained output", { exact: true }).count()).toBe(1);
      });
    });
  }

  it("retires loaded and pending transcripts when the automation panel changes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const jobs: CronJob[] = [
        { id: entry.jobId, name: "Daily report — café 雪 🦞" },
        { id: "empty-job", name: "Weekly cleanup — no runs" },
      ].map(({ id, name }) => ({
        id,
        name,
        configRevision: `synthetic-${id}`,
        enabled: false,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "every", everyMs: 86_400_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic automation" },
        state: {},
      }));
      const runs = (summary: string) => ({
        cases: [
          { match: { id: "empty-job" }, response: { ...cron["cron.runs"], entries: [], total: 0 } },
          { response: { ...cron["cron.runs"], entries: [{ ...entry, summary }] } },
        ],
      });
      const gateway = await installCron(page, {
        "cron.list": cronListResponseFixture({ ...cron["cron.list"], jobs, total: 2 }),
        "cron.get": { cases: jobs.map((job) => ({ match: { id: job.id }, response: job })) },
        "cron.runs": runs("Earlier run"),
        "cron.history": history("Daily report retained output"),
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      const openReportHistory = async () => {
        await page.locator(`[data-test-id="cron-row-${entry.jobId}"] .cron-table__name`).click();
        await detailTab(page, "history").click();
      };
      const transcript = transcriptRegion(page);
      const viewTranscript = buttonNamed(page, "View transcript");
      const output = transcript.getByText("Daily report retained output", { exact: true });
      await openReportHistory();
      await viewTranscript.click();
      await output.waitFor();

      await gateway.setMethodResponse("cron.runs", runs("Refreshed run summary"));
      await gateway.emitGatewayEvent("cron", { jobId: entry.jobId, action: "finished" });
      await page.locator(".cron-run-entry", { hasText: "Refreshed run summary" }).waitFor();
      expect(await output.count()).toBe(1);
      expect(await gateway.getRequests("cron.history")).toHaveLength(1);

      await buttonNamed(page, "All automations").click();
      await page.locator('[data-test-id="cron-row-empty-job"] .cron-table__name').click();
      await page.locator(".cron-detail-title", { hasText: "Weekly cleanup — no runs" }).waitFor();
      await detailTab(page, "history").click();
      await page.getByText("No runs yet", { exact: true }).waitFor();
      expect(await detailTab(page, "history").getAttribute("aria-selected")).toBe("true");
      expect(await detailTab(page, "settings").getAttribute("aria-selected")).toBe("false");
      const proof = createControlUiE2eArtifactDir("automation-transcript-panel-owner");
      await page.screenshot({
        animations: "disabled",
        path: path.join(proof, "selected-automation.png"),
      });
      expect(await transcript.count()).toBe(0);
      expect(await page.locator(".content").evaluate((element) => element.scrollTop)).toBe(0);

      await buttonNamed(page, "All automations").click();
      await openReportHistory();
      await gateway.deferNext("cron.history");
      await viewTranscript.click();
      await gateway.waitForRequest("cron.history", { after: 1 });
      await transcript.getByRole("status").waitFor();
      await buttonNamed(page, "All automations").click();
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator('.cron-page[data-panel-mode="create"]').waitFor();
      expect(await transcript.count()).toBe(0);
      await gateway.resolveDeferred("cron.history", history("Retired daily report response"));
      // Mock delivery dispatches synchronously; join the page update after its request continuation.
      await page.locator("openclaw-cron-page").evaluate(async (element) => {
        await (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
      });
      expect(await transcript.count()).toBe(0);
      const retiredOutput = page.getByText("Retired daily report response", { exact: true });
      expect(await retiredOutput.count()).toBe(0);
    });
  });

  for (const scenario of ["missing-identity", "unavailable"] as const) {
    it(`keeps ${scenario} failures explicit instead of opening a session alias`, async () => {
      await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
        const gateway = await installCron(page, {
          "cron.runs": runResponse({
            runAtMs: scenario === "missing-identity" ? undefined : entry.runAtMs,
          }),
          "cron.history": {
            __mockError: {
              code: "INVALID_REQUEST",
              message: "Recorded run transcript unavailable",
            },
          },
        });
        const { region } = await openRunHistory(page);
        await region.getByRole("alert").waitFor();
        expect(await gateway.getRequests("cron.history")).toHaveLength(
          scenario === "missing-identity" ? 0 : 1,
        );
        expect(new URL(page.url()).pathname).toBe("/cron");
      });
    });
  }
});
