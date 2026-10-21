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
import { cronJob as makeCronJob, cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const contextOptions = createControlUiE2eContextOptions();

type GatewayScenario = NonNullable<Parameters<typeof installMockGateway>[1]>;

function installCronGateway(page: Page, responses: GatewayScenario["methodResponses"] = {}) {
  return installMockGateway(page, {
    methodResponses: {
      "cron.list": cronListResponse([]),
      "cron.runs": cronRunsResponse([]),
      "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
      ...responses,
    },
  });
}

function cronJob(
  id: string,
  name: string,
  schedule: CronJob["schedule"],
  state: CronJob["state"] = {},
): CronJob {
  return makeCronJob(id, name, {
    configRevision: `config-revision-${id}`,
    createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
    schedule,
    payload: { kind: "systemEvent", text: `${name} fired` },
    state,
  });
}

const pageDefaults = { offset: 0, limit: 50, hasMore: false, nextOffset: null };

function cronListResponse(jobs: CronJob[], total = jobs.length) {
  return cronList(jobs, "cron-filters-fixture", { total });
}

function cronRunsResponse(entries: unknown[], total = entries.length) {
  return { entries, total, ...pageDefaults };
}

function run(ts: number, jobId: string, summary: string) {
  return { ts, jobId, status: "ok", summary };
}

async function pressKeys(page: Page, ...keys: string[]) {
  for (const key of keys) {
    await page.keyboard.press(key);
  }
}

const requireRecord = createRequireRecord("record", "expected-object-value");

const requestParams = (request: MockGatewayRequest) => requireRecord(request.params);

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

function button(page: Page, name: string) {
  return page.getByRole("button", { name, exact: true });
}

async function expectCount(page: Page, selector: string, count: number) {
  await expect.poll(() => page.locator(selector).count()).toBe(count);
}

async function expectRunCount(page: Page, summary: string, count: number) {
  await expect
    .poll(() => page.locator(".cron-run-entry", { hasText: summary }).count())
    .toBe(count);
}

function containsAll(value: unknown, expected: string[]) {
  return Array.isArray(value) && expected.every((entry) => value.includes(entry));
}

const defaultListParams = {
  enabled: "all",
  includeDisabled: true,
  lastRunStatus: "all",
  limit: 50,
  offset: 0,
  scheduleKind: "all",
  sortBy: "nextRunAtMs",
  sortDir: "asc",
};
const statuses = ["ok", "error", "skipped"];
const deliveryStatuses = ["delivered", "not-delivered", "unknown"];

async function expectRunRequest(
  gateway: MockGatewayControls,
  after: number,
  predicate: (params: Record<string, unknown>) => boolean,
) {
  await expect
    .poll(async () =>
      (await gateway.getRequests("cron.runs"))
        .slice(after)
        .some((request) => predicate(requestParams(request))),
    )
    .toBe(true);
}

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

suite.define(() => {
  it("sends cron job table filters through the Gateway and renders the filtered page", async () => {
    const everyOk = cronJob(
      "digest-every-ok",
      "Digest every minute",
      { kind: "every", everyMs: 60_000 },
      { lastRunStatus: "ok", lastRunAtMs: Date.parse("2026-05-29T08:10:00.000Z") },
    );
    const cronUnknown = cronJob("nightly-cron-unknown", "Nightly cron pending", {
      kind: "cron",
      expr: "0 1 * * *",
      tz: "UTC",
    });

    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installCronGateway(page, {
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
        "cron.status": {
          enabled: true,
          jobs: 2,
          nextWakeAtMs: Date.parse("2026-05-29T09:00:00.000Z"),
          storePath: "/tmp/openclaw-e2e/cron/jobs.json",
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}cron`);
      expect(response?.status()).toBe(200);
      await jobTitle(page, "Digest every minute").waitFor({ timeout: 10_000 });
      await jobTitle(page, "Nightly cron pending").waitFor({ timeout: 10_000 });

      const initialRequest = await waitForCronListRequest(
        gateway,
        (params) => params.limit === 50 && params.scheduleKind === "all",
      );
      expect(requestParams(initialRequest)).toMatchObject(defaultListParams);

      await page.locator(".cron-filter-popover__trigger").click();
      await page.locator('[data-test-id="cron-jobs-schedule-filter"]').selectOption("cron");
      await page.locator('[data-test-id="cron-jobs-last-status-filter"]').selectOption("unknown");

      const filteredRequest = await waitForCronListRequest(
        gateway,
        (params) => params.scheduleKind === "cron" && params.lastRunStatus === "unknown",
      );
      expect(requestParams(filteredRequest)).toMatchObject({
        ...defaultListParams,
        lastRunStatus: "unknown",
        scheduleKind: "cron",
      });
      await jobTitle(page, "Nightly cron pending").waitFor({ timeout: 10_000 });
      await expect.poll(async () => jobTitle(page, "Digest every minute").count()).toBe(0);
    });
  });

  it("announces selected history filters and sends their Gateway request values", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installCronGateway(page, {
        "cron.runs": cronRunsResponse([
          {
            ts: 1,
            jobId: "filtered-job",
            status: "error",
            deliveryStatus: "delivered",
            summary: "Delivered failure",
          },
        ]),
      });

      await page.goto(`${suite.server.baseUrl}cron`);
      await page.getByRole("tab", { name: "Run history", exact: true }).click();

      const statusFilter = page.locator('[data-filter="status"]');
      const deliveryFilter = page.locator('[data-filter="delivery"]');
      const statusTrigger = statusFilter.locator(".cron-filter-dropdown__trigger");
      const deliveryTrigger = deliveryFilter.locator(".cron-filter-dropdown__trigger");
      await button(page, "Status All statuses").waitFor();
      await button(page, "Delivery All delivery").waitFor();

      const initialRequestCount = (await gateway.getRequests("cron.runs")).length;
      await statusTrigger.click();
      await statusFilter.locator('[data-value="option:error"]').click();
      await button(page, "Status Error").waitFor();
      await statusFilter.locator('[data-value="option:ok"]').click();
      await button(page, "Status OK, Error").waitFor();
      expect(await statusTrigger.textContent()).toContain("OK, Error");
      await statusFilter.locator('[data-value="option:skipped"]').click();
      await button(page, "Status OK +2 (OK, Error, and Skipped)").waitFor();
      expect(await statusTrigger.textContent()).toContain("OK +2");
      await expectRunRequest(gateway, initialRequestCount, (params) =>
        containsAll(params.statuses, statuses),
      );

      const statusRequestCount = (await gateway.getRequests("cron.runs")).length;
      await deliveryTrigger.click();
      await deliveryFilter.locator('[data-value="option:delivered"]').click();
      await button(page, "Delivery Delivered").waitFor();
      await deliveryFilter.locator('[data-value="option:not-delivered"]').click();
      await button(page, "Delivery Delivered, Not delivered").waitFor();
      expect(await deliveryTrigger.textContent()).toContain("Delivered, Not delivered");
      await deliveryFilter.locator('[data-value="option:unknown"]').click();
      await button(page, "Delivery Delivered +2 (Delivered, Not delivered, and Unknown)").waitFor();
      expect(await deliveryTrigger.textContent()).toContain("Delivered +2");
      await expectRunRequest(
        gateway,
        statusRequestCount,
        (params) =>
          containsAll(params.statuses, statuses) &&
          containsAll(params.deliveryStatuses, deliveryStatuses),
      );

      const deliveryRequestCount = (await gateway.getRequests("cron.runs")).length;
      await deliveryFilter.locator('[data-value="command:clear"]').click();
      await button(page, "Delivery All delivery").waitFor();
      await expectRunRequest(
        gateway,
        deliveryRequestCount,
        (params) => containsAll(params.statuses, statuses) && !("deliveryStatuses" in params),
      );

      const clearedDeliveryRequestCount = (await gateway.getRequests("cron.runs")).length;
      await statusTrigger.click();
      await statusFilter.locator('[data-value="command:clear"]').click();
      await button(page, "Status All statuses").waitFor();
      await expectRunRequest(
        gateway,
        clearedDeliveryRequestCount,
        (params) => !("statuses" in params) && !("deliveryStatuses" in params),
      );
    });
  });

  it("localizes history filters and selects them using only native keyboard controls", async () => {
    await suite.withPage({ ...contextOptions, locale: "de-DE" }, async ({ page }) => {
      const gateway = await installCronGateway(page);

      await page.goto(`${suite.server.baseUrl}cron`);
      await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("de");
      await page.getByRole("tab", { name: "Ausführungsverlauf", exact: true }).click();

      const statusFilter = page.locator('[data-filter="status"]');
      const deliveryFilter = page.locator('[data-filter="delivery"]');
      const statusTrigger = statusFilter.locator(".cron-filter-dropdown__trigger");
      const deliveryTrigger = deliveryFilter.locator(".cron-filter-dropdown__trigger");
      await button(page, "Status Alle Status").waitFor();
      await button(page, "Zustellung Alle Zustellungen").waitFor();

      await statusTrigger.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => statusFilter.locator(".oc-menu-item:focus").count()).toBe(1);
      await pressKeys(page, "ArrowDown", "Enter");
      await button(page, "Status Fehler").waitFor();
      await pressKeys(page, "Home", "Enter");
      await button(page, "Status OK, Fehler").waitFor();
      expect(await statusTrigger.textContent()).toContain("OK, Fehler");
      await pressKeys(page, "ArrowDown", "ArrowDown", "Enter");
      await button(page, "Status OK +2 (OK, Fehler und Übersprungen)").waitFor();
      expect(await statusTrigger.textContent()).toContain("OK +2");

      await dismissDropdownToNextTrigger(page, statusTrigger, deliveryTrigger);
      await page.keyboard.press("Enter");
      await expect.poll(() => deliveryFilter.locator(".oc-menu-item:focus").count()).toBe(1);
      await pressKeys(page, "Enter", "ArrowDown", "Enter");
      await button(page, "Zustellung Zugestellt, Nicht zugestellt").waitFor();
      expect(await deliveryTrigger.textContent()).toContain("Zugestellt, Nicht zugestellt");
      await pressKeys(page, "ArrowDown", "Enter");
      await button(
        page,
        "Zustellung Zugestellt +2 (Zugestellt, Nicht zugestellt und Unbekannt)",
      ).waitFor();
      expect(await deliveryTrigger.textContent()).toContain("Zugestellt +2");

      await expectRunRequest(
        gateway,
        0,
        (params) =>
          containsAll(params.statuses, statuses) &&
          containsAll(params.deliveryStatuses, deliveryStatuses),
      );
    });
  });

  it("keeps the newest visible overview when an older history search resolves last", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installCronGateway(page, {
        "cron.runs": cronRunsResponse([run(1, "initial-job", "Initial history")]),
      });

      await page.goto(`${suite.server.baseUrl}cron`);
      await page.getByRole("tab", { name: "Run history", exact: true }).click();
      await expectRunCount(page, "Initial history", 1);

      await gateway.deferNext("cron.runs");
      const search = page.locator(".cron-run-filter-search input");
      await search.fill("stale");
      await expectRunRequest(gateway, 0, (params) => params.query === "stale");

      await gateway.setMethodResponse(
        "cron.runs",
        cronRunsResponse([run(3, "fresh-job", "Newest matching history")]),
      );
      await search.fill("fresh");
      await expectRunCount(page, "Newest matching history", 1);

      await gateway.resolveDeferred(
        "cron.runs",
        cronRunsResponse([run(2, "stale-job", "Stale matching history")]),
      );

      await expectRunCount(page, "Newest matching history", 1);
      await expectRunCount(page, "Stale matching history", 0);
    });
  });

  it("keeps selected task history when a deferred overview refresh resolves last", async () => {
    const selectedJob = {
      ...cronJob("selected-history-job", "Selected history task", {
        kind: "every",
        everyMs: 60_000,
      }),
      description: "Saved selected-task description",
    };
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installCronGateway(page, {
        "cron.list": cronListResponseFixture(cronListResponse([selectedJob])),
        "cron.runs": {
          cases: [
            {
              match: { scope: "job", id: selectedJob.id },
              response: cronRunsResponse([run(2, selectedJob.id, "Selected task history")]),
            },
            {
              match: { scope: "all" },
              response: cronRunsResponse([run(1, "overview-job", "Overview history")]),
            },
          ],
        },
        "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
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
      await expectRunCount(page, "Selected task history", 1);
      expect(
        await page.locator('[data-test-id="cron-detail-description"]').textContent(),
      ).toContain(selectedJob.description);

      await gateway.resolveDeferred(
        "cron.runs",
        cronRunsResponse([run(3, "overview-job", "Late overview history")]),
      );

      await expectRunCount(page, "Selected task history", 1);
      await expectRunCount(page, "Late overview history", 0);

      const statusTrigger = page.locator('[data-filter="status"] .cron-filter-dropdown__trigger');
      const deliveryTrigger = page.locator(
        '[data-filter="delivery"] .cron-filter-dropdown__trigger',
      );
      await statusTrigger.focus();
      await page.keyboard.press("Enter");
      await expectCount(page, '[data-filter="status"] .oc-menu-item:focus', 1);
      await dismissDropdownToNextTrigger(page, statusTrigger, deliveryTrigger);
    });
  });

  it("supports skip navigation and keyboard tab activation", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
      await installCronGateway(page, {
        "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
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
      await pressKeys(page, "ArrowRight", "ArrowRight", "ArrowRight");
      await expect
        .poll(() => activityTab.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Enter");
      await expect.poll(() => activityTab.getAttribute("aria-selected")).toBe("true");
      await expect
        .poll(() => page.getByRole("tabpanel", { name: "Run history" }).isVisible())
        .toBe(true);
    });
  });

  it("shows trigger indicators and filters through cron.list before pagination", async () => {
    const timestamps = {
      createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
    };
    const conditional = makeCronJob("conditional-job", "Conditional job", {
      ...timestamps,
      configRevision: "conditional-revision",
      payload: { kind: "systemEvent", text: "conditional" },
      trigger: { script: "json({ fire: true })" },
      state: { triggerEvalCount: 42, lastTriggerEvalAtMs: Date.now() - 3 * 60_000 },
    });
    const plain = makeCronJob("plain-job", "Plain job", {
      ...timestamps,
      configRevision: "plain-revision",
      payload: { kind: "systemEvent", text: "plain" },
    });
    const list = (jobs: CronJob[]) => cronList(jobs, `trigger-filter:${jobs.length}`);
    await suite.withPage(contextOptions, async ({ page }) => {
      const gateway = await installCronGateway(page, {
        "cron.list": cronListResponseFixture([
          { match: { lastRunStatus: "error" }, response: list([]) },
          { match: { trigger: "conditional" }, response: list([conditional]) },
          { response: list([conditional, plain]) },
        ]),
        "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
        "cron.status": { enabled: true, triggersEnabled: false, jobs: 2, nextWakeAtMs: null },
      });
      await page.goto(`${suite.server.baseUrl}cron`);
      const conditionalRow = page.locator('[data-test-id="cron-row-conditional-job"]');
      await conditionalRow.waitFor();
      await page.locator('[data-test-id="cron-row-plain-job"]').waitFor();
      expect(await conditionalRow.locator(".cron-trigger-icon").getAttribute("aria-label")).toBe(
        "Trigger configured",
      );
      await page.locator(".cron-filter-popover__trigger").click();
      await page.locator('[data-test-id="cron-jobs-trigger-filter"]').selectOption("conditional");
      await waitForCronListRequest(gateway, (params) => params.trigger === "conditional");
      await expectCount(page, '[data-test-id="cron-row-plain-job"]', 0);
      expect(await conditionalRow.count()).toBe(1);
      await conditionalRow.click();
      await page.getByRole("tab", { name: "Run history", exact: true }).click();
      const activity = page.locator('[data-test-id="cron-condition-activity"]');
      await activity.waitFor();
      for (const text of ["42", "3m ago", "Never"]) {
        await expect.poll(() => activity.textContent()).toContain(text);
      }
      await expect
        .poll(() => page.locator(".cron-empty-state").textContent())
        .toContain("No payload runs yet");
    });
  });
});
