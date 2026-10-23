import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createRequireRecord } from "../../../test/helpers/record.js";
import type { CronJob } from "../api/types.ts";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { openPicker } from "../test-helpers/select-picker-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronList } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron agent ownership E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const requireRecord = createRequireRecord("record", "expected-object-value");

const requestParams = (request: MockGatewayRequest) => requireRecord(request.params);

const cronListResponse = (jobs: CronJob[]) => cronList(jobs, "cron-agent-ownership-fixture");
const pageOptions = createControlUiE2eContextOptions();
const cronResponses = {
  "cron.list": cronListResponse([]),
  "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
  "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
};
const models = (id: string, name = id) => ({ models: [{ id, name, provider: "fixture" }] });
const screenshot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`) });
async function openDraft(page: Page, name: string) {
  await page.locator('[data-test-id="cron-new-task"]').click();
  await page.locator("#cron-name").fill(name);
  return page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
}
const option = (picker: Locator, id: string) =>
  picker.locator(`[role="option"][data-value="fixture/${id}"]`);
const expectOption = (picker: Locator, id: string, count: number) =>
  expect.poll(() => option(picker, id).count()).toBe(count);
function expectCatalogReads(requests: MockGatewayRequest[]) {
  const params = requests.filter(({ method }) => method === "models.list").map(requestParams);
  expect(
    params.every((entry) => entry.preparedOnly === undefined && entry.refresh === undefined),
  ).toBe(true);
}
function expectNoWrites(requests: MockGatewayRequest[], extra: string[]) {
  const methods = new Set(["config.set", "config.patch", "cron.add", "cron.update", ...extra]);
  expect(requests.filter(({ method }) => methods.has(method))).toEqual([]);
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
            "models.list": models("fixture/old", "Needle old"),
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const picker = await openDraft(page, "Keep this draft");
        const automations = page.locator("openclaw-cron-page");
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
        expectNoWrites(requests, ["chat.send", "cron.run", "sessions.patch"]);
      });
    },
  );
});
