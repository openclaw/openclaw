import path from "node:path";
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
const cron = {
  "cron.list": {
    jobs: [],
    snapshotRevision: "run-proof",
    total: 0,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  },
  "cron.runs": {
    entries: [entry],
    total: 1,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  },
  "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
};

suite.define(() => {
  for (const runId of [undefined, "recorded-run"] as const) {
    it(`opens and pages the exact recorded run using ${runId ? "runId" : "runAtMs"}`, async () => {
      await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
        const identity = { id: entry.jobId, ...(runId ? { runId } : { runAtMs: entry.runAtMs }) };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...cron,
            "cron.runs": {
              ...cron["cron.runs"],
              entries: [{ ...entry, runId, sessionKey: undefined }],
            },
            "cron.history": {
              cases: [
                {
                  match: { cursor: "older" },
                  response: {
                    messages: [{ role: "user", content: "Earlier prompt" }, introduction],
                    nextCursor: "older",
                  },
                },
                {
                  match: identity,
                  response: {
                    messages: [
                      introduction,
                      { role: "assistant", content: "Exact retained output" },
                    ],
                    nextCursor: "older",
                  },
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.getByRole("tab", { name: "Run history", exact: true }).click();
        const button = page
          .locator(".cron-run-entry")
          .getByRole("button", { name: "View transcript", exact: true });
        await button.click();
        const region = page.getByRole("region", { name: "Run transcript", exact: true });
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
        await region.getByRole("button", { name: "Retry", exact: true }).click();
        await region.getByText("Earlier prompt", { exact: true }).waitFor();
        expect(await region.getByRole("button", { name: /Show earlier/ }).count()).toBe(0);
        const attribution = region.locator(".chat-reply-attribution--forwarded");
        expect(await attribution.count()).toBe(1);
        expect(await attribution.textContent()).toContain("Daily report — café 雪 🦞");
        expect(await attribution.locator("a, [role=link], [tabindex]").count()).toBe(0);
        expect(await region.locator(".sr-only").allTextContents()).toEqual([
          "User: ",
          "Assistant: ",
        ]);
        expect(await attribution.evaluate((element) => getComputedStyle(element).display)).toBe(
          "inline-flex",
        );
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
        await region.getByRole("button", { name: "Close", exact: true }).click();
        expect(await button.evaluate((element) => element === document.activeElement)).toBe(true);
        await gateway.deferNext("cron.history", { ...identity, limit: 100 });
        await button.click();
        await expect.poll(async () => (await gateway.getRequests("cron.history")).length).toBe(4);
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1012, "Reconnect run transcript");
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await region.waitFor({ state: "detached" });
        await gateway.resolveDeferred("cron.history", {
          messages: [{ role: "assistant", content: "Stale output" }],
        });
        expect(await page.getByText("Stale output", { exact: true }).count()).toBe(0);
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
      const gateway = await installMockGateway(page, {
        methodResponses: {
          ...cron,
          "cron.list": cronListResponseFixture({ ...cron["cron.list"], jobs, total: 2 }),
          "cron.get": { cases: jobs.map((job) => ({ match: { id: job.id }, response: job })) },
          "cron.runs": runs("Earlier run"),
          "cron.history": {
            messages: [{ role: "assistant", content: "Daily report retained output" }],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      const openReportHistory = async () => {
        await page.locator(`[data-test-id="cron-row-${entry.jobId}"] .cron-table__name`).click();
        await page.locator('[data-test-id="cron-detail-tab-history"]').click();
      };
      const transcript = page.getByRole("region", { name: "Run transcript", exact: true });
      const viewTranscript = page.getByRole("button", { name: "View transcript", exact: true });
      await openReportHistory();
      await viewTranscript.click();
      await transcript.getByText("Daily report retained output", { exact: true }).waitFor();

      // A new run-log snapshot on the same panel must not dismiss the recorded transcript.
      await gateway.setMethodResponse("cron.runs", runs("Refreshed run summary"));
      await gateway.emitGatewayEvent("cron", { jobId: entry.jobId, action: "finished" });
      await page.locator(".cron-run-entry", { hasText: "Refreshed run summary" }).waitFor();
      expect(
        await transcript.getByText("Daily report retained output", { exact: true }).count(),
      ).toBe(1);
      expect(await gateway.getRequests("cron.history")).toHaveLength(1);

      await page.getByRole("button", { name: "All automations", exact: true }).click();
      await page.locator('[data-test-id="cron-row-empty-job"] .cron-table__name').click();
      await page.locator(".cron-detail-title", { hasText: "Weekly cleanup — no runs" }).waitFor();
      await page.locator('[data-test-id="cron-detail-tab-history"]').click();
      await page.getByText("No runs yet", { exact: true }).waitFor();
      expect(
        await page
          .locator('[data-test-id="cron-detail-tab-history"]')
          .getAttribute("aria-selected"),
      ).toBe("true");
      expect(
        await page
          .locator('[data-test-id="cron-detail-tab-settings"]')
          .getAttribute("aria-selected"),
      ).toBe("false");
      const proof = createControlUiE2eArtifactDir("automation-transcript-panel-owner");
      await page.screenshot({
        animations: "disabled",
        path: path.join(proof, "selected-automation.png"),
      });
      expect(await transcript.count()).toBe(0);
      expect(await page.locator(".content").evaluate((element) => element.scrollTop)).toBe(0);

      await page.getByRole("button", { name: "All automations", exact: true }).click();
      await openReportHistory();
      await gateway.deferNext("cron.history");
      await viewTranscript.click();
      await gateway.waitForRequest("cron.history", { after: 1 });
      await transcript.getByRole("status").waitFor();
      await page.getByRole("button", { name: "All automations", exact: true }).click();
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator('.cron-page[data-panel-mode="create"]').waitFor();
      expect(await transcript.count()).toBe(0);
      await gateway.resolveDeferred("cron.history", {
        messages: [{ role: "assistant", content: "Retired daily report response" }],
      });
      // Mock delivery dispatches synchronously; join the page update after its request continuation.
      await page.locator("openclaw-cron-page").evaluate(async (element) => {
        await (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
      });
      expect(await transcript.count()).toBe(0);
      expect(await page.getByText("Retired daily report response", { exact: true }).count()).toBe(
        0,
      );
    });
  });

  for (const scenario of ["missing-identity", "unavailable"] as const) {
    it(`keeps ${scenario} failures explicit instead of opening a session alias`, async () => {
      await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...cron,
            "cron.runs": {
              ...cron["cron.runs"],
              entries: [
                { ...entry, runAtMs: scenario === "missing-identity" ? undefined : entry.runAtMs },
              ],
            },
            "cron.history": {
              __mockError: {
                code: "INVALID_REQUEST",
                message: "Recorded run transcript unavailable",
              },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.getByRole("tab", { name: "Run history", exact: true }).click();
        await page
          .locator(".cron-run-entry")
          .getByRole("button", { name: "View transcript", exact: true })
          .click();
        await page
          .getByRole("region", { name: "Run transcript", exact: true })
          .getByRole("alert")
          .waitFor();
        expect(await gateway.getRequests("cron.history")).toHaveLength(
          scenario === "missing-identity" ? 0 : 1,
        );
        expect(new URL(page.url()).pathname).toBe("/cron");
      });
    });
  }
});
