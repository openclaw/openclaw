// Control UI tests cover cron filters behavior.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { CronJob } from "../api/types.ts";
import {
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function cronJob(
  id: string,
  name: string,
  schedule: CronJob["schedule"],
  state: CronJob["state"] = {},
): CronJob {
  return {
    id,
    configRevision: `config-revision-${id}`,
    name,
    enabled: true,
    createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
    schedule,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: `${name} fired` },
    state,
  };
}

function cronListResponse(jobs: CronJob[], total = jobs.length) {
  return {
    jobs,
    snapshotRevision: "cron-filters-fixture",
    total,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

function cronRunsResponse(entries: unknown[], total = entries.length) {
  return {
    entries,
    total,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

async function waitForCronListRequest(
  gateway: MockGatewayControls,
  predicate: (params: Record<string, unknown>) => boolean,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  let requests: MockGatewayRequest[] = [];
  while (Date.now() < deadline) {
    requests = await gateway.getRequests("cron.list");
    const match = requests.find((request) => predicate(requestParams(request)));
    if (match) {
      return match;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`No matching cron.list request found: ${JSON.stringify(requests)}`);
}

type PageDiagnostics = {
  consoleMessages: string[];
  pageErrors: string[];
};

function jobTitle(page: Page, name: string) {
  return page.locator(".cron-table__name-text", { hasText: new RegExp(`^${name}$`, "u") });
}

async function dismissDropdownToNextTrigger(page: Page, trigger: Locator, nextTrigger: Locator) {
  await page.keyboard.press("Escape");
  expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
  expect(await trigger.getAttribute("aria-expanded")).toBe("false");
  await page.keyboard.press("Tab");
  await expect
    .poll(() => nextTrigger.evaluate((element) => element === document.activeElement))
    .toBe(true);
}

async function waitForJobTitle(
  page: Page,
  gateway: MockGatewayControls,
  diagnostics: PageDiagnostics,
  name: string,
) {
  try {
    await jobTitle(page, name).waitFor({ timeout: 10_000 });
  } catch (err) {
    const requests = await gateway.getRequests();
    const bodyText = await page.locator("body").textContent({ timeout: 1_000 }).catch(String);
    const content = await page.content().catch(String);
    throw new Error(
      [
        `Timed out waiting for cron job title: ${name}`,
        `URL: ${page.url()}`,
        `Gateway requests: ${JSON.stringify(requests)}`,
        `Page errors: ${JSON.stringify(diagnostics.pageErrors)}`,
        `Console: ${JSON.stringify(diagnostics.consoleMessages)}`,
        `Page text: ${bodyText}`,
        `Page content: ${content.slice(0, 1000)}`,
        `Original error: ${String(err)}`,
      ].join("\n"),
      { cause: err },
    );
  }
}

suite.define(() => {
  it("sends cron job table filters through the Gateway and renders the filtered page", async () => {
    const everyOk = cronJob(
      "digest-every-ok",
      "Digest every minute",
      { kind: "every", everyMs: 60_000 },
      { lastRunStatus: "ok", lastRunAtMs: Date.parse("2026-05-29T08:10:00.000Z") },
    );
    const cronUnknown = cronJob(
      "nightly-cron-unknown",
      "Nightly cron pending",
      { kind: "cron", expr: "0 1 * * *", tz: "UTC" },
      {},
    );

    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const pageErrors: string[] = [];
      const consoleMessages: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(String(err)));
      page.on("console", (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "cron.list": cronListResponseFixture([
            {
              match: { scheduleKind: "cron", lastRunStatus: "unknown" },
              response: cronListResponse([cronUnknown]),
            },
            {
              match: {},
              response: cronListResponse([everyOk, cronUnknown], 2),
            },
          ]),
          "cron.runs": {
            entries: [],
            total: 0,
            offset: 0,
            limit: 50,
            hasMore: false,
            nextOffset: null,
          },
          "cron.status": {
            enabled: true,
            jobs: 2,
            nextWakeAtMs: Date.parse("2026-05-29T09:00:00.000Z"),
            storePath: "/tmp/openclaw-e2e/cron/jobs.json",
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}cron`);
      expect(response?.status()).toBe(200);
      await waitForJobTitle(page, gateway, { consoleMessages, pageErrors }, "Digest every minute");
      await waitForJobTitle(page, gateway, { consoleMessages, pageErrors }, "Nightly cron pending");

      const initialRequest = await waitForCronListRequest(
        gateway,
        (params) => params.limit === 50 && params.scheduleKind === "all",
      );
      expect(requestParams(initialRequest)).toMatchObject({
        enabled: "all",
        includeDisabled: true,
        lastRunStatus: "all",
        limit: 50,
        offset: 0,
        scheduleKind: "all",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      });

      await page.locator(".cron-filter-popover__trigger").click();
      await page.locator('[data-test-id="cron-jobs-schedule-filter"]').selectOption("cron");
      await page.locator('[data-test-id="cron-jobs-last-status-filter"]').selectOption("unknown");

      const filteredRequest = await waitForCronListRequest(
        gateway,
        (params) => params.scheduleKind === "cron" && params.lastRunStatus === "unknown",
      );
      expect(requestParams(filteredRequest)).toMatchObject({
        enabled: "all",
        includeDisabled: true,
        lastRunStatus: "unknown",
        limit: 50,
        offset: 0,
        scheduleKind: "cron",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
      });
      await waitForJobTitle(page, gateway, { consoleMessages, pageErrors }, "Nightly cron pending");
      await expect.poll(async () => jobTitle(page, "Digest every minute").count()).toBe(0);
    });
  });

  it("keeps read-only operators on Cron browse and history surfaces", async () => {
    const readOnlyJob = {
      ...cronJob(
        "read-only-job",
        "Read-only nightly digest",
        { kind: "cron", expr: "0 1 * * *", tz: "UTC" },
        { lastRunStatus: "ok", lastRunAtMs: Date.parse("2026-05-29T08:10:00.000Z") },
      ),
      description: "Explain the nightly digest without granting write access",
    };
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read"],
          methodResponses: {
            "cron.list": cronListResponseFixture(cronListResponse([readOnlyJob])),
            "cron.runs": cronRunsResponse([
              {
                ts: 1,
                jobId: readOnlyJob.id,
                jobName: readOnlyJob.name,
                status: "ok",
                summary: "Read-only history remains available",
              },
            ]),
            "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await jobTitle(page, readOnlyJob.name).waitFor({ timeout: 10_000 });
        await page.getByRole("note").filter({ hasText: "Browsing only" }).waitFor();
        expect(
          await page
            .locator(`[data-test-id="cron-row-description-${readOnlyJob.id}"]`)
            .textContent(),
        ).toContain(readOnlyJob.description);

        await expect.poll(() => page.locator('[data-test-id="cron-new-task"]').count()).toBe(0);
        await expect
          .poll(() => page.locator(`[data-test-id="cron-row-run-${readOnlyJob.id}"]`).count())
          .toBe(0);
        await expect
          .poll(() => page.locator(`[data-test-id="cron-row-toggle-${readOnlyJob.id}"]`).count())
          .toBe(0);
        await expect.poll(() => page.locator(".cron-job-menu").count()).toBe(0);
        await expect.poll(() => page.locator("[data-suggestion]").count()).toBe(0);
        expect(await page.locator(".cron-filter-popover__trigger").count()).toBe(1);

        await jobTitle(page, readOnlyJob.name).click();
        await page.locator("fieldset.cron-editor:disabled").waitFor();
        expect(
          await page.locator('[data-test-id="cron-detail-description"]').textContent(),
        ).toContain(readOnlyJob.description);
        await expect.poll(() => page.locator('[data-test-id="cron-run-now"]').count()).toBe(0);
        await expect.poll(() => page.locator('[data-test-id="cron-submit"]').count()).toBe(0);
        await expect.poll(() => page.locator(".cron-editor-actions").count()).toBe(0);

        await page.locator('[data-test-id="cron-detail-tab-history"]').click();
        await page.getByText("Read-only history remains available", { exact: true }).waitFor();
        expect(
          await page.locator('[data-test-id="cron-detail-description"]').textContent(),
        ).toContain(readOnlyJob.description);

        const mutationMethods = new Set(["cron.add", "cron.remove", "cron.run", "cron.update"]);
        expect(
          (await gateway.getRequests()).filter((request) => mutationMethods.has(request.method)),
        ).toHaveLength(0);
      },
    );
  });

  it("announces selected history filters and sends their Gateway request values", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponse([]),
            "cron.runs": cronRunsResponse([
              {
                ts: 1,
                jobId: "filtered-job",
                status: "error",
                deliveryStatus: "delivered",
                summary: "Delivered failure",
              },
            ]),
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.getByRole("tab", { name: "Run history", exact: true }).click();

        const statusFilter = page.locator('[data-filter="status"]');
        const deliveryFilter = page.locator('[data-filter="delivery"]');
        const statusTrigger = statusFilter.locator(".cron-filter-dropdown__trigger");
        const deliveryTrigger = deliveryFilter.locator(".cron-filter-dropdown__trigger");
        await page.getByRole("button", { name: "Status All statuses", exact: true }).waitFor();
        await page.getByRole("button", { name: "Delivery All delivery", exact: true }).waitFor();

        const initialRequestCount = (await gateway.getRequests("cron.runs")).length;
        await statusTrigger.click();
        await statusFilter.locator('[data-value="option:error"]').click();
        await page.getByRole("button", { name: "Status Error", exact: true }).waitFor();
        await statusFilter.locator('[data-value="option:ok"]').click();
        await page.getByRole("button", { name: "Status OK, Error", exact: true }).waitFor();
        expect(await statusTrigger.textContent()).toContain("OK, Error");
        await statusFilter.locator('[data-value="option:skipped"]').click();
        await page
          .getByRole("button", { name: "Status OK +2 (OK, Error, and Skipped)", exact: true })
          .waitFor();
        expect(await statusTrigger.textContent()).toContain("OK +2");
        await expect
          .poll(async () =>
            (await gateway.getRequests("cron.runs")).slice(initialRequestCount).some((request) => {
              const params = requestParams(request);
              const statuses = params.statuses;
              return (
                Array.isArray(statuses) &&
                ["ok", "error", "skipped"].every((status) => statuses.includes(status))
              );
            }),
          )
          .toBe(true);

        const statusRequestCount = (await gateway.getRequests("cron.runs")).length;
        await deliveryTrigger.click();
        await deliveryFilter.locator('[data-value="option:delivered"]').click();
        await page.getByRole("button", { name: "Delivery Delivered", exact: true }).waitFor();
        await deliveryFilter.locator('[data-value="option:not-delivered"]').click();
        await page
          .getByRole("button", { name: "Delivery Delivered, Not delivered", exact: true })
          .waitFor();
        expect(await deliveryTrigger.textContent()).toContain("Delivered, Not delivered");
        await deliveryFilter.locator('[data-value="option:unknown"]').click();
        await page
          .getByRole("button", {
            name: "Delivery Delivered +2 (Delivered, Not delivered, and Unknown)",
            exact: true,
          })
          .waitFor();
        expect(await deliveryTrigger.textContent()).toContain("Delivered +2");
        await expect
          .poll(async () =>
            (await gateway.getRequests("cron.runs")).slice(statusRequestCount).some((request) => {
              const params = requestParams(request);
              const statuses = params.statuses;
              const deliveryStatuses = params.deliveryStatuses;
              return (
                Array.isArray(statuses) &&
                ["ok", "error", "skipped"].every((status) => statuses.includes(status)) &&
                Array.isArray(deliveryStatuses) &&
                ["delivered", "not-delivered", "unknown"].every((status) =>
                  deliveryStatuses.includes(status),
                )
              );
            }),
          )
          .toBe(true);

        const deliveryRequestCount = (await gateway.getRequests("cron.runs")).length;
        await deliveryFilter.locator('[data-value="command:clear"]').click();
        await page.getByRole("button", { name: "Delivery All delivery", exact: true }).waitFor();
        await expect
          .poll(async () =>
            (await gateway.getRequests("cron.runs")).slice(deliveryRequestCount).some((request) => {
              const params = requestParams(request);
              const statuses = params.statuses;
              return (
                Array.isArray(statuses) &&
                ["ok", "error", "skipped"].every((status) => statuses.includes(status)) &&
                !("deliveryStatuses" in params)
              );
            }),
          )
          .toBe(true);

        const clearedDeliveryRequestCount = (await gateway.getRequests("cron.runs")).length;
        await statusTrigger.click();
        await statusFilter.locator('[data-value="command:clear"]').click();
        await page.getByRole("button", { name: "Status All statuses", exact: true }).waitFor();
        await expect
          .poll(async () =>
            (await gateway.getRequests("cron.runs"))
              .slice(clearedDeliveryRequestCount)
              .some((request) => {
                const params = requestParams(request);
                return !("statuses" in params) && !("deliveryStatuses" in params);
              }),
          )
          .toBe(true);
      },
    );
  });

  it("localizes history filters and selects them using only native keyboard controls", async () => {
    await suite.withPage(
      {
        locale: "de-DE",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponse([]),
            "cron.runs": cronRunsResponse([]),
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("de");
        await page.getByRole("tab", { name: "Ausführungsverlauf", exact: true }).click();

        const statusFilter = page.locator('[data-filter="status"]');
        const deliveryFilter = page.locator('[data-filter="delivery"]');
        const statusTrigger = statusFilter.locator(".cron-filter-dropdown__trigger");
        const deliveryTrigger = deliveryFilter.locator(".cron-filter-dropdown__trigger");
        await page.getByRole("button", { name: "Status Alle Status", exact: true }).waitFor();
        await page
          .getByRole("button", { name: "Zustellung Alle Zustellungen", exact: true })
          .waitFor();

        await statusTrigger.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => statusFilter.locator(".oc-menu-item:focus").count()).toBe(1);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "Status Fehler", exact: true }).waitFor();
        await page.keyboard.press("Home");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "Status OK, Fehler", exact: true }).waitFor();
        expect(await statusTrigger.textContent()).toContain("OK, Fehler");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page
          .getByRole("button", { name: "Status OK +2 (OK, Fehler und Übersprungen)", exact: true })
          .waitFor();
        expect(await statusTrigger.textContent()).toContain("OK +2");

        await dismissDropdownToNextTrigger(page, statusTrigger, deliveryTrigger);
        await page.keyboard.press("Enter");
        await expect.poll(() => deliveryFilter.locator(".oc-menu-item:focus").count()).toBe(1);
        await page.keyboard.press("Enter");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page
          .getByRole("button", { name: "Zustellung Zugestellt, Nicht zugestellt", exact: true })
          .waitFor();
        expect(await deliveryTrigger.textContent()).toContain("Zugestellt, Nicht zugestellt");
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await page
          .getByRole("button", {
            name: "Zustellung Zugestellt +2 (Zugestellt, Nicht zugestellt und Unbekannt)",
            exact: true,
          })
          .waitFor();
        expect(await deliveryTrigger.textContent()).toContain("Zugestellt +2");

        await expect
          .poll(async () =>
            (await gateway.getRequests("cron.runs")).some((request) => {
              const params = requestParams(request);
              const statuses = params.statuses;
              const deliveryStatuses = params.deliveryStatuses;
              return (
                Array.isArray(statuses) &&
                ["ok", "error", "skipped"].every((status) => statuses.includes(status)) &&
                Array.isArray(deliveryStatuses) &&
                ["delivered", "not-delivered", "unknown"].every((status) =>
                  deliveryStatuses.includes(status),
                )
              );
            }),
          )
          .toBe(true);
      },
    );
  });

  it("keeps the newest visible overview when an older history search resolves last", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponse([]),
            "cron.runs": cronRunsResponse([
              { ts: 1, jobId: "initial-job", status: "ok", summary: "Initial history" },
            ]),
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.getByRole("tab", { name: "Run history", exact: true }).click();
        await expect
          .poll(() => page.locator(".cron-run-entry", { hasText: "Initial history" }).count())
          .toBe(1);

        await gateway.deferNext("cron.runs");
        const search = page.locator(".cron-run-filter-search input");
        await search.fill("stale");
        await expect
          .poll(async () =>
            (await gateway.getRequests("cron.runs")).some(
              (request) => requestParams(request).query === "stale",
            ),
          )
          .toBe(true);

        await gateway.setMethodResponse(
          "cron.runs",
          cronRunsResponse([
            { ts: 3, jobId: "fresh-job", status: "ok", summary: "Newest matching history" },
          ]),
        );
        await search.fill("fresh");
        await expect
          .poll(() =>
            page.locator(".cron-run-entry", { hasText: "Newest matching history" }).count(),
          )
          .toBe(1);

        await gateway.resolveDeferred(
          "cron.runs",
          cronRunsResponse([
            { ts: 2, jobId: "stale-job", status: "ok", summary: "Stale matching history" },
          ]),
        );

        await expect
          .poll(() =>
            page.locator(".cron-run-entry", { hasText: "Newest matching history" }).count(),
          )
          .toBe(1);
        await expect
          .poll(() =>
            page.locator(".cron-run-entry", { hasText: "Stale matching history" }).count(),
          )
          .toBe(0);
      },
    );
  });

  it("keeps selected task history when a deferred overview refresh resolves last", async () => {
    const selectedJob = cronJob("selected-history-job", "Selected history task", {
      kind: "every",
      everyMs: 60_000,
    });
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponseFixture(cronListResponse([selectedJob])),
            "cron.runs": {
              cases: [
                {
                  match: { scope: "job", id: selectedJob.id },
                  response: cronRunsResponse([
                    {
                      ts: 2,
                      jobId: selectedJob.id,
                      status: "ok",
                      summary: "Selected task history",
                    },
                  ]),
                },
                {
                  match: { scope: "all" },
                  response: cronRunsResponse([
                    { ts: 1, jobId: "overview-job", status: "ok", summary: "Overview history" },
                  ]),
                },
              ],
            },
            "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await jobTitle(page, selectedJob.name).waitFor({ timeout: 10_000 });

        const previousHistoryRequestCount = (await gateway.getRequests("cron.runs")).length;
        await gateway.deferNext("cron.runs");
        await gateway.emitGatewayEvent("cron", {});
        await expect
          .poll(async () => (await gateway.getRequests("cron.runs")).length)
          .toBeGreaterThan(previousHistoryRequestCount);

        await jobTitle(page, selectedJob.name).click();
        await page.locator('[data-test-id="cron-detail-tab-history"]').click();
        await expect
          .poll(() => page.locator(".cron-run-entry", { hasText: "Selected task history" }).count())
          .toBe(1);

        await gateway.resolveDeferred(
          "cron.runs",
          cronRunsResponse([
            { ts: 3, jobId: "overview-job", status: "ok", summary: "Late overview history" },
          ]),
        );

        await expect
          .poll(() => page.locator(".cron-run-entry", { hasText: "Selected task history" }).count())
          .toBe(1);
        await expect
          .poll(() => page.locator(".cron-run-entry", { hasText: "Late overview history" }).count())
          .toBe(0);

        const statusTrigger = page.locator('[data-filter="status"] .cron-filter-dropdown__trigger');
        const deliveryTrigger = page.locator(
          '[data-filter="delivery"] .cron-filter-dropdown__trigger',
        );
        await statusTrigger.focus();
        await page.keyboard.press("Enter");
        await expect
          .poll(() => page.locator('[data-filter="status"] .oc-menu-item:focus').count())
          .toBe(1);
        await dismissDropdownToNextTrigger(page, statusTrigger, deliveryTrigger);
      },
    );
  });

  it("creates and edits agent-turn jobs with an explicit zero timeout", async () => {
    const existingJob = {
      ...cronJob("existing-no-timeout", "Existing no-timeout task", {
        kind: "every",
        everyMs: 60_000,
      }),
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "Continue until the existing task finishes",
        timeoutSeconds: 0,
      },
    } satisfies CronJob;
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.add": { id: "created-no-timeout" },
            "cron.update": { id: existingJob.id },
            "cron.list": cronListResponseFixture(cronListResponse([existingJob])),
            "cron.runs": cronRunsResponse([]),
            "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await jobTitle(page, existingJob.name).waitFor({ timeout: 10_000 });

        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Created no-timeout task");
        await page.locator("#cron-payload-text").fill("Continue until the new task finishes");
        await page.locator("details.cron-advanced > summary").click();
        await page.locator("#cron-timeout-seconds").fill("0");
        await page.locator('[data-test-id="cron-submit"]').click();

        const addRequest = await gateway.waitForRequest("cron.add");
        expect(requestParams(addRequest)).toMatchObject({
          name: "Created no-timeout task",
          payload: {
            kind: "agentTurn",
            message: "Continue until the new task finishes",
            timeoutSeconds: 0,
          },
        });

        await jobTitle(page, existingJob.name).waitFor({ timeout: 10_000 });
        await jobTitle(page, existingJob.name).click();
        await page.locator("details.cron-advanced > summary").click();
        expect(await page.locator("#cron-timeout-seconds").inputValue()).toBe("0");
        await page.locator("#cron-payload-text").fill("Continue until the edited task finishes");
        await page.locator('[data-test-id="cron-submit"]').click();

        const updateRequest = await gateway.waitForRequest("cron.update");
        expect(requestParams(updateRequest)).toMatchObject({
          id: existingJob.id,
          expectedConfigRevision: existingJob.configRevision,
          patch: {
            payload: {
              kind: "agentTurn",
              message: "Continue until the edited task finishes",
              timeoutSeconds: 0,
            },
          },
        });
      },
    );
  });

  it("supports skip navigation and keyboard tab activation", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponse([]),
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-tab-all"]').waitFor();

        await page.keyboard.press("Tab");
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim()))
          .toBe("Skip to main content");
        await page.keyboard.press("Enter");
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.id))
          .toBe("control-ui-main");

        const tasksTab = page.getByRole("tab", { name: "All", exact: true });
        const activityTab = page.getByRole("tab", { name: "Run history", exact: true });
        await tasksTab.focus();
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await expect
          .poll(() => activityTab.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.keyboard.press("Enter");
        await expect.poll(() => activityTab.getAttribute("aria-selected")).toBe("true");
        await expect
          .poll(() => page.getByRole("tabpanel", { name: "Run history" }).isVisible())
          .toBe(true);
      },
    );
  });
});
