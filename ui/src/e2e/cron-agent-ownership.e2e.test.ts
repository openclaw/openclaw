// Control UI browser proof covers explicit automation ownership across widened page scope.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
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

function cronListResponse(jobs: unknown[]) {
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

suite.define(() => {
  it.each([false, true])(
    "shows internal catalog failure in Automations and model search (retained rows: %s)",
    async (hasRows) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1_280 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            models: [],
            methodResponses: {
              "models.list": {
                models: [{ provider: "fixture", id: "fixture/old", name: "Needle old" }],
              },
              "cron.list": cronListResponse([]),
              "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
              "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
            },
          });
          await page.goto(`${suite.server.baseUrl}cron`);
          await page.locator('[data-test-id="cron-new-task"]').click();
          await page.locator("#cron-name").fill("Keep this draft");
          const automations = page.locator("openclaw-cron-page");
          const picker = page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
          await expect
            .poll(() => picker.locator('[role="option"][data-value="fixture/old"]').count())
            .toBe(1);
          await page.keyboard.press("Control+K");
          const palette = page.locator(".cmd-palette");
          await page.locator(".cmd-palette__input").fill("needle");
          await palette.getByText("Needle old", { exact: true }).waitFor();
          const readView = async () => ({
            automations: await automations.textContent(),
            palette: await palette.textContent(),
            draft: await page.locator("#cron-name").inputValue(),
            modelOptions: await picker.locator('[role="option"]').allTextContents(),
          });
          const before = await readView();
          await page.screenshot({
            path: path.join(suite.artifactDir, `internal-catalog-before-${hasRows}.png`),
          });

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
          await palette.getByRole("status").filter({ hasText: warning }).waitFor();
          expect(await palette.getByText("Needle old", { exact: true }).count()).toBe(0);
          expect(await palette.getByText("Needle current", { exact: true }).count()).toBe(
            hasRows ? 1 : 0,
          );
          expect(await picker.locator('[role="option"][data-value="fixture/old"]').count()).toBe(0);
          const failure = await readView();
          await page.screenshot({
            path: path.join(suite.artifactDir, `internal-catalog-palette-${hasRows}.png`),
          });
          await page.keyboard.press("Escape");
          await palette.waitFor({ state: "hidden" });
          await automations.getByText(warning, { exact: true }).waitFor();
          await page.screenshot({
            path: path.join(suite.artifactDir, `internal-catalog-automations-${hasRows}.png`),
          });
          await page.keyboard.press("Control+K");
          await page.locator(".cmd-palette__input").fill("needle");
          await palette.getByRole("status").filter({ hasText: warning }).waitFor();

          await gateway.setMethodResponse("models.list", { models: [] });
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          await expect.poll(() => automations.getByText(warning, { exact: true }).count()).toBe(0);
          await expect.poll(() => palette.getByRole("status").count()).toBe(0);
          expect(await palette.getByText("Needle current", { exact: true }).count()).toBe(0);
          expect(await page.locator("#cron-name").inputValue()).toBe("Keep this draft");
          const requests = await gateway.getRequests();
          await writeFile(
            path.join(suite.artifactDir, `internal-catalog-observations-${hasRows}.json`),
            JSON.stringify(
              {
                hasRows,
                fixture: "mock Gateway; real Control UI browser",
                before,
                failure,
                recovery: await readView(),
                // Connection admission is outside this synthetic catalog scenario.
                requests: requests.filter(({ method }) => method !== "connect"),
              },
              null,
              2,
            ),
          );
          await page.screenshot({
            path: path.join(suite.artifactDir, `internal-catalog-recovery-${hasRows}.png`),
          });
          expect(
            requests
              .filter(({ method }) => method === "models.list")
              .every(({ params }) => {
                const values = requireRecord(params);
                return values.preparedOnly === undefined && values.refresh === undefined;
              }),
          ).toBe(true);
          expect(
            requests.filter(({ method }) =>
              ["config.set", "config.patch", "cron.add", "cron.update", "chat.send"].includes(
                method,
              ),
            ),
          ).toEqual([]);
        },
      );
    },
  );

  it("refreshes model suggestions after catalog changes without replacing the draft", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
        recordVideo: { dir: suite.artifactDir },
      },
      async ({ page }) => {
        const models = (id: string) => ({ models: [{ id, name: id, provider: "fixture" }] });
        const gateway = await installMockGateway(page, {
          models: [],
          methodResponses: {
            "models.list": models("fixture/old"),
            "cron.list": cronListResponse([]),
            "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill("Keep this draft");
        const picker = page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
        await picker.locator(".picker-select__trigger").click();
        await picker.locator('[role="option"][data-value="fixture/old"]').waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "initial.png") });
        await page.keyboard.press("Escape");
        // Finish the hide animation before a later click reopens the picker.
        await picker.getByRole("listbox").waitFor({ state: "hidden" });

        await gateway.setMethodResponse("models.list", models("fixture/new"));
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expect
          .poll(() => picker.locator('[role="option"][data-value="fixture/new"]').count())
          .toBe(1);
        expect(await picker.locator('[role="option"][data-value="fixture/old"]').count()).toBe(0);
        await picker.locator(".picker-select__trigger").click();
        await picker.locator('[role="option"][data-value="fixture/new"]').waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "refreshed.png") });
        await page.keyboard.press("Escape");
        await picker.getByRole("listbox").waitFor({ state: "hidden" });

        await gateway.setMethodResponse("models.list", {
          __mockError: { code: "UNAVAILABLE", message: "Model suggestions unavailable" },
        });
        await gateway.emitGatewayEvent("config.changed", {});
        await page.getByText("Model suggestions unavailable", { exact: true }).waitFor();
        expect(await picker.locator('[role="option"][data-value="fixture/new"]').count()).toBe(1);
        await page.screenshot({ path: path.join(suite.artifactDir, "failed-refresh.png") });

        await gateway.setMethodResponse("models.list", { models: [] });
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await expect
          .poll(() => picker.locator('[role="option"][data-value="fixture/new"]').count())
          .toBe(0);
        await expect
          .poll(() => page.getByText("Model suggestions unavailable", { exact: true }).count())
          .toBe(0);
        expect(await page.locator("#cron-name").inputValue()).toBe("Keep this draft");
        const requests = await gateway.getRequests();
        expect(
          requests
            .filter(({ method }) => method === "models.list")
            .every(({ params }) => {
              const values = requireRecord(params);
              return values.preparedOnly === undefined && values.refresh === undefined;
            }),
        ).toBe(true);
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
    };
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          assistantName: "Assistant",
          methodResponses: {
            "agents.list": {
              agents: [
                { id: "main", identity: { name: "Assistant" }, name: "Assistant" },
                { id: "writer", identity: { name: "Writer" }, name: "Writer" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "cron.add": { id: createdJob.id },
            "cron.list": {
              cases: [
                { match: { lastRunStatus: "error" }, response: cronListResponse([]) },
                { response: cronListResponse([]) },
              ],
            },
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await gateway.waitForRequest("agents.list");
        const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
        await pageScope.locator(".agent-select__trigger").click();
        await pageScope
          .locator("wa-dropdown-item[data-agent-option]")
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
        await gateway.setMethodResponse("cron.list", {
          cases: [
            { match: { lastRunStatus: "error" }, response: cronListResponse([]) },
            { response: cronListResponse([createdJob]) },
          ],
        });
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
      },
    );
  });
});
