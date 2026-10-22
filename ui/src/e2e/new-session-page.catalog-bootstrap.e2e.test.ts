import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol/frame-guards";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import { navigationAgents } from "./new-session-page.navigation-fixtures.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const model = (id: string, name: string) => ({ provider: "fixture", id, name, available: true });
const current = model("current", "Current model");
const older = model("older", "Older model");
const option = (page: Page, id: string) => page.locator(`[data-chat-model-option="fixture/${id}"]`);
const absent = (page: Page, id: string) => expect(option(page, id).count()).resolves.toBe(0);
const visible = (page: Page) => expect.poll(() => option(page, "current").isVisible()).toBe(true);
async function reveal(page: Page) {
  await revealChatModelOption(option(page, "current"));
  await visible(page);
}
function catalogScenario(ids = ["alpha", "bravo"]) {
  return {
    connectCapabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT],
    defaultAgentId: "alpha",
    agentModel: "fixture/current",
    heldMethods: ["models.list"],
    models: [older],
    methodResponses: {
      "agents.list": navigationAgents(ids, "per-sender", "fixture/current"),
    },
  };
}

suite.define(() => {
  it.each([
    { route: "new?agent=alpha", agentId: "alpha", hint: "alpha" },
    { route: "new?agent=bravo", agentId: "bravo", hint: "bravo" },
    { route: "new", agentId: "alpha", hint: undefined },
    { route: "new?agent=missing", agentId: "alpha", hint: "missing" },
  ])(
    "opens $route for $agentId despite saved bravo selection while its older models.list reply is held",
    async ({ route, agentId, hint }) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
        await page.addInitScript(
          ({ key, value }) => {
            localStorage.setItem(key, value);
          },
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            value: JSON.stringify({
              gatewayUrl,
              sessionsByGateway: {
                [gatewayOriginScope(gatewayUrl)]: {
                  sessionKey: "agent:bravo:main",
                  lastActiveSessionKey: "agent:bravo:main",
                  selectedAgentId: "bravo",
                },
              },
            }),
          },
        );
        const gateway = await installMockGateway(page, catalogScenario());
        const snapshot = (models: (typeof current)[], pendingProviders?: string[]) =>
          gateway.emitGatewayEvent("models.snapshot", {
            target: hint ? { agentId: hint } : {},
            scope: { agentId },
            catalog: { models, ...(pendingProviders ? { pendingProviders } : {}) },
          });
        const foreignSnapshot = {
          target: { agentId: agentId === "alpha" ? "bravo" : "alpha" },
          scope: { agentId: agentId === "alpha" ? "bravo" : "alpha" },
          catalog: { models: [{ ...current, id: "foreign", name: "Other agent model" }] },
        };
        const trigger = page.locator("[data-chat-model-select]");
        await page.goto(`${suite.server.baseUrl}${route}`);
        const connected = await gateway.waitForRequest("connect");
        expect(connected.params).toMatchObject({ modelCatalog: hint ? { agentId: hint } : {} });
        await expect
          .poll(async () => (await gateway.getRequests("models.list", { agentId })).length)
          .toBe(1);
        await gateway.emitGatewayEvent("models.snapshot", foreignSnapshot);
        expect(await gateway.getRequests("models.list", { agentId })).toHaveLength(1);
        await snapshot([current], ["fixture"]);
        await gateway.emitGatewayEvent("models.snapshot", foreignSnapshot);
        const requestsBeforeOpen = (await gateway.getRequests("models.list")).length;
        await trigger.click();
        await reveal(page);
        expect((await gateway.getRequests("models.list")).length - requestsBeforeOpen).toBe(0);
        expect(await page.locator("[data-chat-model-refresh]").textContent()).toContain(
          "Refreshing models for Fixture…",
        );
        expect(await page.locator("[data-chat-model-catalog-state]").count()).toBe(0);

        await gateway.resolveDeferred("models.list", { models: [older] });
        await visible(page);
        await absent(page, "older");
        await absent(page, "foreign");
        await snapshot([older]);
        await trigger.click();
        await trigger.click();
        await reveal(page);
        await absent(page, "older");
        expect((await gateway.getRequests("models.list")).length - requestsBeforeOpen).toBe(0);
      }),
  );

  it("reloads the current catalog after a late initial snapshot without losing its draft", async () =>
    suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, catalogScenario(["alpha"]));
      const trigger = page.locator("[data-chat-model-select]");
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("models.list", { match: { agentId: "alpha" } });
      await gateway.resolveDeferred("models.list", { models: [current] });
      const message = page.locator(".new-session-page__message");
      await message.fill("Catalog draft");
      await waitForCommittedComposerDraft(page, JSON.stringify(["", "", ""]), "Catalog draft", 0);
      await trigger.click();
      await reveal(page);
      await gateway.emitGatewayEvent("models.snapshot", {
        target: {},
        scope: { agentId: "alpha" },
        catalog: { models: [older] },
      });
      await page.reload();
      await gateway.waitForRequest("models.list", { match: { agentId: "alpha" } });
      await gateway.resolveDeferred("models.list", { models: [current] });
      await trigger.click();
      await reveal(page);
      await absent(page, "older");
      expect(await message.inputValue()).toBe("Catalog draft");
    }));
});
