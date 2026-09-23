import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

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
const task = {
  id: "exact-old-task",
  taskId: "exact-old-task",
  runtime: "cron",
  kind: "automation_run",
  status: "completed",
  title: "Earlier run",
  agentId: "main",
  sourceId: entry.jobId,
  childSessionKey: entry.sessionKey,
  startedAt: entry.runAtMs,
  createdAt: 1000,
  updatedAt: 2000,
  hasTranscript: true,
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
  it("opens the exact paginated retained task without navigating to its deleted session alias", async () => {
    await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          ...cron,
          "tasks.list": {
            cases: [
              { match: { cursor: "next" }, response: { tasks: [task] } },
              {
                match: { sessionKey: entry.sessionKey },
                response: {
                  tasks: [{ ...task, id: "other", taskId: "other", sourceId: "other-job" }],
                  nextCursor: "next",
                },
              },
            ],
          },
          "tasks.get": { task },
          "tasks.history": {
            messages: [{ role: "assistant", content: "Exact retained old output" }],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      await page.getByRole("tab", { name: "Run history", exact: true }).click();
      await page
        .locator(".cron-run-entry")
        .getByText(/View transcript|Open run chat/)
        .click();
      const region = page.getByRole("region", { name: "Task transcript", exact: true });
      await region.getByText("Exact retained old output", { exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/cron");
      expect(await gateway.getRequests("tasks.history")).toMatchObject([
        { params: { taskId: task.id } },
      ]);
      expect(await gateway.getRequests("tasks.list")).toMatchObject([
        { params: { sessionKey: entry.sessionKey } },
        { params: { sessionKey: entry.sessionKey, cursor: "next" } },
      ]);
      await gateway.emitGatewayEvent("task", { action: "deleted", taskId: task.id });
      await region.waitFor({ state: "detached" });
      const button = page
        .locator(".cron-run-entry")
        .getByRole("button", { name: "View transcript", exact: true });
      await gateway.deferNext("tasks.get", { taskId: task.id });
      await button.click();
      await expect.poll(async () => (await gateway.getRequests("tasks.get")).length).toBe(2);
      await gateway.emitGatewayEvent("task", { action: "deleted", taskId: task.id });
      await region.waitFor({ state: "detached" });
      await gateway.resolveDeferred("tasks.get", { task });
      expect(await gateway.getRequests("tasks.history")).toHaveLength(1);
      await gateway.deferNext("tasks.list", { sessionKey: entry.sessionKey, limit: 500 });
      await button.click();
      await expect.poll(async () => (await gateway.getRequests("tasks.list")).length).toBe(5);
      const socketCount = await gateway.getSocketCount();
      await gateway.closeLatest(1012, "Reconnect run transcript");
      await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
      await region.waitFor({ state: "detached" });
      await gateway.resolveDeferred("tasks.list", { tasks: [task] });
      expect(await gateway.getRequests("tasks.history")).toHaveLength(1);
    });
  });

  for (const scenario of ["duplicate", "missing", "stale", "missing-time"] as const) {
    it(`rejects ${scenario} exact-run resolution without reading any transcript`, async () => {
      await suite.withPage({ viewport: { width: 1100, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...cron,
            ...(scenario === "missing-time"
              ? {
                  "cron.runs": {
                    ...cron["cron.runs"],
                    entries: [{ ...entry, runAtMs: undefined }],
                  },
                }
              : {}),
            "tasks.list": {
              cases: [
                {
                  match: { cursor: "next" },
                  response:
                    scenario === "stale"
                      ? {
                          __mockError: {
                            code: "INVALID_REQUEST",
                            message:
                              "invalid or expired tasks.list cursor; restart pagination without a cursor",
                          },
                        }
                      : {
                          tasks:
                            scenario === "duplicate"
                              ? [{ ...task, id: "duplicate", taskId: "duplicate" }]
                              : [],
                        },
                },
                {
                  match: { sessionKey: entry.sessionKey },
                  response: { tasks: scenario === "missing" ? [] : [task], nextCursor: "next" },
                },
              ],
            },
            "tasks.get": { task },
            "tasks.history": {
              messages: [{ role: "assistant", content: "Wrong output must not load" }],
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
          .getByRole("region", { name: "Task transcript", exact: true })
          .getByRole("alert")
          .waitFor();
        expect(await gateway.getRequests("tasks.history")).toHaveLength(0);
        expect(await gateway.getRequests("tasks.get")).toHaveLength(0);
      });
    });
  }
});
