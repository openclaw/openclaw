import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { cronListResponseFixture } from "../test-helpers/cron.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  cronJob,
  cronList,
  cronRuns,
  cronSidebarFeatureMethods,
} from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation agent picker",
  startServerBeforeBrowser: true,
});

const roster = [
  { id: "main", name: "Clawd" },
  { id: "writer", name: "Writer" },
];
const retired = cronJob("retired-owner", "Retired owner digest", {
  agentId: "retired-bot",
  configRevision: "retired-revision",
  sessionTarget: "isolated",
  payload: { kind: "agentTurn", message: "Summarize the fictional week." },
});

function installGateway(page: Page, agents = roster, jobs: CronJob[] = [retired]) {
  return installMockGateway(page, {
    featureMethods: cronSidebarFeatureMethods,
    methodResponses: {
      "agents.list": { agents, defaultId: "main", mainKey: "main", scope: "per-sender" },
      "cron.list": cronListResponseFixture(cronList(jobs, "agent-picker-list")),
      "cron.get": { cases: jobs.map((job) => ({ match: { id: job.id }, response: job })) },
      "cron.runs": cronRuns([]),
      "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
      "cron.add": { ...retired, id: "created" },
      "cron.update": { ...retired, agentId: undefined },
    },
  });
}

const agentPicker = (page: Page) => page.locator(".cron-editor-placement openclaw-agent-select");

async function chooseAgent(page: Page, name: string) {
  await agentPicker(page).locator(".agent-select__trigger").click();
  await page.getByRole("option", { name, exact: true }).click();
}

suite.define(() => {
  it("creates an automation for the agent picked from the roster", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installGateway(page);
      await page.goto(`${suite.server.baseUrl}cron?new`);
      await page.locator("#cron-name").fill("Synthetic garden inventory");
      await page.locator("#cron-payload-text").fill("Summarize the fictional garden inventory.");
      await chooseAgent(page, "Writer");
      await expect
        .poll(() => agentPicker(page).locator(".agent-select__label").textContent())
        .toBe("Writer");
      await page.locator('[data-test-id="cron-submit"]').click();
      expect((await gateway.waitForRequest("cron.add")).params).toMatchObject({
        agentId: "writer",
      });
    });
  });

  it("shows a stored agent missing from the roster and clears it with Default", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installGateway(page);
      // The sidebar lists the selected agent's automations, so open this one by its address.
      await page.goto(`${suite.server.baseUrl}cron?job=${retired.id}`);
      await page.locator('[data-test-id="cron-edit"]').click();
      const trigger = agentPicker(page).locator(".agent-select__trigger");
      await expect
        .poll(() => trigger.getAttribute("aria-label"))
        .toBe("Agent: retired-bot, Not found");
      await chooseAgent(page, "Default (Clawd)");
      await page.locator('[data-test-id="cron-submit"]').click();
      expect((await gateway.waitForRequest("cron.update")).params).toMatchObject({
        id: retired.id,
        patch: { agentId: null },
      });
    });
  });

  it("leaves out the Agent row when the Gateway has one agent", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await installGateway(page, roster.slice(0, 1));
      await page.goto(`${suite.server.baseUrl}cron?new`);
      await page.waitForFunction(() => window.openclawControlUi?.snapshot().rosterReady === true);
      const titles = page.locator(".cron-editor-placement .settings-row__title");
      await titles.first().waitFor();
      expect(await titles.allTextContents()).toEqual(["Runs in"]);
    });
  });
});
