import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI creation drafts across routes",
});
const name = "Synthetic automation name";
const prompt = "Synthetic authoring input retained across navigation. 0123456789";
const source: CronJob = {
  id: "draft-clone-source",
  configRevision: "source-definition",
  name: "Synthetic clone source",
  enabled: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 60_000, anchorMs: 1_725_000_000_123 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: {
    kind: "agentTurn",
    message: prompt,
    toolsAllow: ["read"],
    fallbacks: ["synthetic/model"],
    allowUnsafeExternalContent: false,
  },
  state: {},
};
const list = (jobs: CronJob[]) => ({
  jobs,
  snapshotRevision: "draft-inventory",
  total: jobs.length,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
});
async function setup(page: Page, jobs = [source]) {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
  const config = { ui: { prefs: { sidebarEntries: ["route:cron", "route:usage"] } } };
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "config.get": {
        config,
        raw: JSON.stringify(config),
        hash: "creation-draft-sidebar",
        valid: true,
      },
      "sessions.usage": {
        updatedAt: 1,
        startDate: "2026-09-16",
        endDate: "2026-09-16",
        sessions: [],
        totals,
        aggregates: {
          messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
          tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
          byModel: [],
          byProvider: [],
          byAgent: [],
          byChannel: [],
          daily: [],
        },
      },
      "usage.cost": { updatedAt: 1, days: 1, daily: [], totals },
      "cron.list": list(jobs),
      "cron.get": source,
      "cron.status": { enabled: false, jobs: jobs.length, nextWakeAtMs: null },
      "cron.runs": {
        entries: [],
        total: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },
      "cron.add": { id: "created-draft" },
      "cron.run": { ok: true, ran: true },
    },
  });
  await page.goto(`${suite.server.baseUrl}automations`);
  await page.locator('[data-test-id="cron-new-task"]').waitFor();
  return gateway;
}
async function sidebar(page: Page, route: "usage" | "cron") {
  const pathname = route === "cron" ? "automations" : "usage";
  const link = page.locator(`.nav-item[href="/${pathname}"]`);
  await link.waitFor({ state: "attached" });
  const expand = page.getByRole("button", { name: "Expand sidebar", exact: true });
  if (await expand.isVisible()) {
    await expand.click();
  }
  await link.click();
  await page.waitForURL(`**/${pathname}`);
  await page.locator(route === "cron" ? "openclaw-cron-page" : "openclaw-usage-page").waitFor();
}
async function author(page: Page) {
  await page.locator('[data-test-id="cron-new-task"]').click();
  await page.locator("#cron-name").fill(name);
  await page.locator("#cron-payload-text").fill(prompt);
}
async function returnToCreation(page: Page) {
  await sidebar(page, "usage");
  await sidebar(page, "cron");
  // Either an automatically reopened editor or an explicit resume entry is valid.
  if (!(await page.locator("#cron-name").isVisible())) {
    await page.locator('[data-test-id="cron-new-task"]').click();
  }
  await page.locator("#cron-name").waitFor();
}

suite.define(() => {
  it.each([
    { mode: "new", width: 1280, height: 900 },
    { mode: "clone", width: 1280, height: 900 },
    { mode: "new", width: 390, height: 844 },
  ])(
    "retains $mode authoring through sidebar routes at $width",
    async ({ mode, width, height }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width, height } },
        async ({ page }) => {
          const gateway = await setup(page);
          if (mode === "clone") {
            await page.locator(`[data-test-id="cron-row-${source.id}"]`).click();
            const menu = page.locator(".cron-detail-actions wa-dropdown");
            await menu.locator('button[slot="trigger"]').click();
            await menu.locator('wa-dropdown-item[value="clone"]').click();
            await page.locator("#cron-name").fill(name);
          } else {
            await author(page);
          }
          expect(name).toHaveLength(25);
          expect(prompt).toHaveLength(64);
          await page.locator("#cron-payload-text").evaluate((input: HTMLTextAreaElement) => {
            input.focus();
            input.setSelectionRange(62, 64);
          });
          const instance = await page.locator("openclaw-cron-page").elementHandle();
          const input = await page.locator("#cron-name").elementHandle();
          const observe = async () => ({
            nameLength: await page
              .locator("#cron-name")
              .evaluate((node: HTMLInputElement) => node.value.length),
            promptLength: await page
              .locator("#cron-payload-text")
              .evaluate((node: HTMLTextAreaElement) => node.value.length),
            oldPageConnected: await instance!.evaluate((node) => node.isConnected),
            oldInputConnected: await input!.evaluate((node) => node.isConnected),
            requests: Object.fromEntries(
              await Promise.all(
                [
                  "cron.list",
                  "cron.status",
                  "cron.runs",
                  "models.list",
                  "cron.add",
                  "cron.update",
                  "cron.remove",
                  "cron.run",
                ].map(async (method) => [method, (await gateway.getRequests(method)).length]),
              ),
            ),
          });
          const before = await observe();
          const observations = [before];
          const artifact = `${mode}-${width}`;
          await page.screenshot({
            animations: "disabled",
            path: path.join(suite.artifactDir, `${artifact}-before-navigation.png`),
          });
          try {
            await returnToCreation(page);
            const after = await observe();
            observations.push(after);
            await page.screenshot({
              animations: "disabled",
              path: path.join(suite.artifactDir, `${artifact}-after-navigation.png`),
            });
            expect(after).toMatchObject({
              nameLength: 25,
              promptLength: 64,
              oldPageConnected: false,
              oldInputConnected: false,
            });
            expect(await page.locator("#cron-name").inputValue()).toBe(name);
            expect(await page.locator("#cron-payload-text").inputValue()).toBe(prompt);
            expect(after.requests["cron.list"]).toBeGreaterThan(before.requests["cron.list"]);
            for (const method of ["cron.add", "cron.update", "cron.remove", "cron.run"]) {
              expect(await gateway.getRequests(method)).toHaveLength(0);
            }
            if (mode === "clone") {
              await page.locator('[data-test-id="cron-submit"]').click();
              const request = await gateway.waitForRequest("cron.add");
              expect(request.params).toMatchObject({
                name,
                enabled: false,
                schedule: source.schedule,
                payload: source.payload,
              });
            }
          } finally {
            writeFileSync(
              path.join(suite.artifactDir, `${artifact}-navigation.json`),
              JSON.stringify(
                { tier: "Chromium with mocked Gateway", viewport: { width, height }, observations },
                null,
                2,
              ),
            );
            await instance?.dispose();
            await input?.dispose();
          }
        },
      );
    },
  );

  it.each([false, true])(
    "retains submission admission through routes (run now: %s)",
    async (runNow) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const gateway = await setup(page);
          await author(page);
          await gateway.deferNext("cron.add");
          if (runNow) {
            await gateway.deferNext("cron.run");
          }
          await page
            .locator(`[data-test-id="${runNow ? "cron-submit-run" : "cron-submit"}"]`)
            .click();
          await gateway.waitForRequest("cron.add");
          await returnToCreation(page);
          expect(await page.locator('[data-test-id="cron-submit"]').isDisabled()).toBe(true);
          expect(await page.locator('[data-test-id="cron-submit-run"]').isDisabled()).toBe(true);
          expect(await gateway.getRequests("cron.add")).toHaveLength(1);
          await gateway.resolveDeferred("cron.add", { id: "created-draft" });
          if (runNow) {
            await gateway.waitForRequest("cron.run");
            await returnToCreation(page);
            expect(await page.locator('[data-test-id="cron-submit"]').isDisabled()).toBe(true);
            expect(await gateway.getRequests("cron.add")).toHaveLength(1);
            await gateway.resolveDeferred("cron.run", { ok: true, ran: true });
          }
          await expect.poll(() => page.locator("#cron-name").count()).toBe(0);
          await page.locator('[data-test-id="cron-new-task"]').click();
          expect(await page.locator("#cron-name").inputValue()).toBe("");
          expect(await gateway.getRequests("cron.add")).toHaveLength(1);
          expect(await gateway.getRequests("cron.run")).toHaveLength(runNow ? 1 : 0);
        },
      );
    },
  );

  it("discards explicitly canceled drafts and keeps suggestion authoring on return", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await setup(page, []);
        await author(page);
        await page.locator('[data-test-id="cron-back"]').click();
        await sidebar(page, "usage");
        await sidebar(page, "cron");
        expect(await page.locator("#cron-name").count()).toBe(0);
        await page.locator('[data-suggestion="repoPulse"]').click();
        const suggestion = {
          name: await page.locator("#cron-name").inputValue(),
          prompt: await page.locator("#cron-payload-text").inputValue(),
        };
        expect(suggestion.name).not.toBe(name);
        await returnToCreation(page);
        expect(await page.locator("#cron-name").inputValue()).toBe(suggestion.name);
        expect(await page.locator("#cron-payload-text").inputValue()).toBe(suggestion.prompt);
        await page.locator('[data-test-id="cron-submit"]').click();
        expect((await gateway.waitForRequest("cron.add")).params).toMatchObject({
          name: suggestion.name,
          schedule: { kind: "cron", expr: "0 9 * * 1-5" },
          payload: { kind: "agentTurn", message: suggestion.prompt },
        });
      },
    );
  });

  it.each([
    { route: "job", phase: "authoring" },
    { route: "session", phase: "authoring" },
    { route: "job", phase: "running" },
    { route: "session", phase: "running" },
  ])(
    "preserves explicit $route navigation and completion feedback while $phase",
    async ({ route, phase }) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const gateway = await setup(page);
          await author(page);
          if (phase === "running") {
            await gateway.deferNext("cron.run");
            await page.locator('[data-test-id="cron-submit-run"]').click();
            await gateway.waitForRequest("cron.run");
          }
          await sidebar(page, "usage");
          await page.evaluate(
            (url) => {
              history.pushState(null, "", url);
              window.dispatchEvent(new PopStateEvent("popstate"));
            },
            `${suite.server.baseUrl}automations?${route === "job" ? `job=${source.id}` : "session=agent%3Amain%3Asynthetic&agent=main"}`,
          );
          await expect.poll(() => page.locator("#cron-name").inputValue()).toBe(source.name);
          expect(await page.locator(".cron-detail-title").textContent()).toBe(source.name);
          if (phase === "running") {
            await gateway.rejectDeferred("cron.run", {
              code: "UNAVAILABLE",
              message: "Synthetic run unavailable",
            });
            await expect
              .poll(async () =>
                (await page.locator(".app-toast__message").allTextContents()).join("\n"),
              )
              .toContain("Synthetic run unavailable");
            expect(await page.locator("#cron-name").inputValue()).toBe(source.name);
          }
          expect(await gateway.getRequests("cron.add")).toHaveLength(phase === "running" ? 1 : 0);
          expect(await gateway.getRequests("cron.run")).toHaveLength(phase === "running" ? 1 : 0);
          expect(await gateway.getRequests("cron.update")).toHaveLength(0);
        },
      );
    },
  );
});
