// Control UI browser proof covers explicit automation ownership across widened page scope.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { CronJob } from "../api/types.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import { openPicker } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron agent ownership E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

function cronListResponse(jobs: CronJob[]) {
  return {
    jobs,
    snapshotRevision: "cron-agent-ownership-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

const pageOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1_280 },
} as const;
const cronResponses = {
  "cron.list": cronListResponse([]),
  "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
  "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
};
const models = (id: string) => ({ models: [{ id, name: id, provider: "fixture" }] });
const agents = (name: string) => ({
  agents: [
    { id: "main", identity: { name }, name },
    { id: "writer", identity: { name: "Writer" }, name: "Writer" },
  ],
  defaultId: "main",
  mainKey: "main",
  scope: "agent",
});
const screenshot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`) });
const observations = (name: string, value: unknown) =>
  writeFile(path.join(suite.artifactDir, `${name}.json`), JSON.stringify(value, null, 2));
const option = (picker: Locator, id: string) =>
  picker.locator(`[role="option"][data-value="fixture/${id}"]`);
const expectOption = (picker: Locator, id: string, count: number) =>
  expect.poll(() => option(picker, id).count()).toBe(count);
function expectCatalogReads(requests: MockGatewayRequest[]) {
  expect(
    requests
      .filter(({ method }) => method === "models.list")
      .every(({ params }) => {
        const values = requireRecord(params);
        return values.preparedOnly === undefined && values.refresh === undefined;
      }),
  ).toBe(true);
}

suite.define(() => {
  it.each([false, true])(
    "keeps catalog warnings in Automations and out of model search (retained rows: %s)",
    async (hasRows) => {
      await suite.withPage(pageOptions, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          models: [],
          methodResponses: {
            ...cronResponses,
            "models.list": {
              models: [{ provider: "fixture", id: "fixture/old", name: "Needle old" }],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Keep this draft");
        const automations = page.locator("openclaw-cron-page");
        const picker = page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
        await openPicker(picker);
        await expectOption(picker, "old", 1);
        await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+K");
        const palette = page.locator(".cmd-palette");
        await page.locator(".cmd-palette__input").fill("needle");
        await palette.getByText("Needle old", { exact: true }).waitFor();
        await screenshot(page, `internal-catalog-before-${hasRows}`);

        await gateway.setMethodResponse("models.list", {
          models: hasRows
            ? [{ provider: "fixture", id: "fixture/current", name: "Needle current" }]
            : [],
          refreshFailed: true,
        });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        const warning = hasRows
          ? "Some models could not be refreshed. Open Models to try again."
          : "Models unavailable";
        await automations.getByText(warning, { exact: true }).waitFor();
        await expect.poll(() => palette.getByText("Needle old", { exact: true }).count()).toBe(0);
        expect(await palette.getByText(warning, { exact: true }).count()).toBe(0);
        expect(await palette.getByText("Needle current", { exact: true }).count()).toBe(
          hasRows ? 1 : 0,
        );
        await screenshot(page, `internal-catalog-palette-${hasRows}`);
        await page.keyboard.press("Escape");
        await palette.waitFor({ state: "hidden" });
        await openPicker(picker);
        expect(await option(picker, "old").count()).toBe(0);
        expect(await option(picker, "current").count()).toBe(hasRows ? 1 : 0);
        await page.keyboard.press("Escape");
        await automations.getByText(warning, { exact: true }).waitFor();
        await screenshot(page, `internal-catalog-automations-${hasRows}`);
        const searchesBeforeReopen = (await gateway.getRequests("sessions.search")).length;
        await page.keyboard.press("ControlOrMeta+K");
        await page.locator(".cmd-palette__input").fill("needle");
        await expect
          .poll(async () => (await gateway.getRequests("sessions.search")).length)
          .toBeGreaterThan(searchesBeforeReopen);
        await expect
          .poll(() => palette.locator(".cmd-palette__results").getAttribute("aria-busy"))
          .toBe("false");
        expect(await palette.getByText(warning, { exact: true }).count()).toBe(0);

        await gateway.setMethodResponse("models.list", { models: [] });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expect.poll(() => automations.getByText(warning, { exact: true }).count()).toBe(0);
        await expect
          .poll(() => palette.locator(".cmd-palette__search").getByRole("status").count())
          .toBe(0);
        expect(await palette.getByText("Needle current", { exact: true }).count()).toBe(0);
        expect(await page.locator("#cron-name").inputValue()).toBe("Keep this draft");
        const requests = await gateway.getRequests();
        await screenshot(page, `internal-catalog-recovery-${hasRows}`);
        expectCatalogReads(requests);
        expect(
          requests.filter(({ method }) =>
            ["config.set", "config.patch", "cron.add", "cron.update", "chat.send"].includes(method),
          ),
        ).toEqual([]);
      });
    },
  );

  it("refreshes model suggestions after catalog changes without replacing the draft", async () => {
    await suite.withPage(
      {
        ...pageOptions,
        recordVideo: { dir: suite.artifactDir },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          models: [],
          methodResponses: {
            ...cronResponses,
            "models.list": models("fixture/old"),
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Keep this draft");
        const picker = page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
        await openPicker(picker);
        await option(picker, "old").waitFor();
        await screenshot(page, "initial");
        await page.keyboard.press("Escape");
        // Finish the hide animation before a later click reopens the picker.
        await picker.getByRole("listbox").waitFor({ state: "hidden" });

        await gateway.setMethodResponse("models.list", models("fixture/new"));
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await openPicker(picker);
        await expectOption(picker, "new", 1);
        expect(await option(picker, "old").count()).toBe(0);
        await option(picker, "new").waitFor();
        await screenshot(page, "refreshed");
        await page.keyboard.press("Escape");
        await picker.getByRole("listbox").waitFor({ state: "hidden" });

        await gateway.setMethodResponse("models.list", {
          __mockError: { code: "UNAVAILABLE", message: "Model suggestions unavailable" },
        });
        await gateway.emitGatewayEvent("config.changed", {});
        await page.getByText("Model suggestions unavailable", { exact: true }).waitFor();
        await openPicker(picker);
        expect(await option(picker, "new").count()).toBe(1);
        await screenshot(page, "failed-refresh");

        await gateway.setMethodResponse("models.list", { models: [] });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expectOption(picker, "new", 0);
        await expect
          .poll(() => page.getByText("Model suggestions unavailable", { exact: true }).count())
          .toBe(0);
        expect(await page.locator("#cron-name").inputValue()).toBe("Keep this draft");
        const requests = await gateway.getRequests();
        expectCatalogReads(requests);
        expect(
          requests.filter(({ method }) =>
            [
              "config.set",
              "config.patch",
              "cron.add",
              "cron.update",
              "cron.run",
              "sessions.patch",
            ].includes(method),
          ),
        ).toEqual([]);
      },
    );
  });

  it("refreshes model suggestions when the roster selection changes", async () => {
    await suite.withPage(
      {
        ...pageOptions,
        recordVideo: { dir: suite.artifactDir },
      },
      async ({ page }) => {
        await page.addInitScript(
          ({ key }) => {
            localStorage.setItem(key, JSON.stringify({ sidebarAgentsMode: "roster" }));
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const gateway = await installMockGateway(page, {
          models: [],
          methodResponses: {
            ...cronResponses,
            "agents.list": agents("Main"),
            "models.list": {
              cases: [
                {
                  match: { agentId: "writer", view: "configured" },
                  response: models("fixture/writer"),
                },
                {
                  match: { agentId: "main", view: "configured" },
                  response: models("fixture/main"),
                },
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await gateway.waitForRequest("models.list", {
          match: { agentId: "main", view: "configured" },
        });
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Keep this roster draft");
        const picker = page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
        await openPicker(picker);
        await expectOption(picker, "main", 1);
        await screenshot(page, "roster-model-main");
        await page.keyboard.press("Escape");
        await picker.getByRole("listbox").waitFor({ state: "hidden" });
        const inventoryReadsBeforeSwitch = (await gateway.getRequests("cron.list")).length;

        await evaluateControlUiContext(page, (context) => {
          context.agentSelection.set("writer");
        });
        await gateway.waitForRequest("models.list", {
          match: { agentId: "writer", view: "configured" },
        });
        await openPicker(picker);
        await expectOption(picker, "writer", 1);
        expect(await option(picker, "main").count()).toBe(0);
        expect(await page.locator("#cron-name").inputValue()).toBe("Keep this roster draft");
        await screenshot(page, "roster-model-writer");

        const requests = await gateway.getRequests();
        const inventoryRequests = requests.filter(({ method }) => method === "cron.list");
        expect(inventoryRequests.length).toBeGreaterThanOrEqual(inventoryReadsBeforeSwitch);
        expect(
          inventoryRequests.every((request) => requestParams(request).agentId === undefined),
        ).toBe(true);
        await observations("roster-model-observations", {
          fixture: "mock Gateway; real Control UI browser",
          inventoryReadsBeforeSwitch,
          inventoryReadsAfterSwitch: inventoryRequests.length,
          inventoryRequestParams: inventoryRequests.map(({ params }) => params),
          modelRequests: requests
            .filter(({ method }) => method === "models.list")
            .map(({ params }) => params),
          draft: await page.locator("#cron-name").inputValue(),
          modelOptions: await picker.locator('[role="option"]').allTextContents(),
        });
      },
    );
  });

  it("keeps the selected agent as owner while browsing all agents", async () => {
    const createdJob = {
      id: "weekday-report",
      agentId: "main",
      name: "Weekday report",
      enabled: true,
      createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
      schedule: { kind: "every", everyMs: 1_800_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Prepare the weekday report" },
      state: {},
    } satisfies CronJob;
    await suite.withPage(pageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "Assistant",
        methodResponses: {
          ...cronResponses,
          "agents.list": agents("Assistant"),
          "cron.add": { id: createdJob.id },
          "cron.list": {
            cases: [
              { match: { lastRunStatus: "error" }, response: cronListResponse([]) },
              { response: cronListResponse([]) },
            ],
          },
          "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
        },
      });

      await page.goto(`${suite.server.baseUrl}cron`);
      await gateway.waitForRequest("agents.list");
      const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
      await pageScope.locator(".agent-select__trigger").click();
      await pageScope
        .locator(".agent-select__option[data-agent-option]")
        .filter({ hasText: "All agents" })
        .click();
      await expect
        .poll(() =>
          pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
        )
        .toBe("");

      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator("#cron-name").fill(createdJob.name);
      await page.locator("#cron-payload-text").fill(createdJob.payload.message);
      await gateway.setMethodResponse(
        "cron.list",
        cronListResponseFixture([
          { match: { lastRunStatus: "error" }, response: cronListResponse([]) },
          { response: cronListResponse([createdJob]) },
        ]),
      );
      await page.locator('[data-test-id="cron-submit"]').click();

      expect(requestParams(await gateway.waitForRequest("models.list"))).toEqual({
        agentId: "main",
        view: "configured",
      });
      expect(requestParams(await gateway.waitForRequest("cron.add"))).toMatchObject({
        agentId: "main",
        name: createdJob.name,
        payload: createdJob.payload,
      });
      await page
        .locator(".cron-table__name-text", { hasText: createdJob.name })
        .waitFor({ state: "visible", timeout: 10_000 });
    });
  });
});
