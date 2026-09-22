import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { route: "new?agent=alpha", agentId: "alpha", hint: "alpha" },
    { route: "new?agent=bravo", agentId: "bravo", hint: "bravo" },
    { route: "new", agentId: "alpha", hint: undefined },
    { route: "new?agent=missing", agentId: "alpha", hint: "missing" },
  ])(
    "opens $route for $agentId despite saved bravo selection while its older models.list reply is held",
    async ({ route, agentId, hint }) => {
      const context = await suite.browser.newContext(createControlUiE2eContextOptions());
      const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
      await context.addInitScript(
        ({ key, url, scope }) => {
          localStorage.setItem(
            key,
            JSON.stringify({
              gatewayUrl: url,
              sessionsByGateway: {
                [scope]: {
                  sessionKey: "agent:bravo:main",
                  lastActiveSessionKey: "agent:bravo:main",
                  selectedAgentId: "bravo",
                },
              },
            }),
          );
        },
        {
          key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          url: gatewayUrl,
          scope: gatewayOriginScope(gatewayUrl),
        },
      );
      const page = await context.newPage();
      const current = {
        provider: "fixture",
        id: "current",
        name: "Current model",
        available: true,
      };
      const older = { provider: "fixture", id: "older", name: "Older model", available: true };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "alpha",
        agentModel: "fixture/current",
        heldMethods: ["models.list"],
        models: [older],
        methodResponses: {
          "agents.list": {
            defaultId: "alpha",
            mainKey: "main",
            scope: "per-sender",
            agents: [
              { id: "alpha", name: "Alpha", model: { primary: "fixture/current" } },
              { id: "bravo", name: "Bravo", model: { primary: "fixture/current" } },
            ],
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}${route}`);
        const connected = await gateway.waitForRequest("connect");
        expect(connected.params).toMatchObject({ modelCatalog: hint ? { agentId: hint } : {} });
        await expect
          .poll(async () => (await gateway.getRequests("models.list", { agentId })).length)
          .toBe(1);
        await gateway.emitGatewayEvent("models.snapshot", {
          target: { agentId: agentId === "alpha" ? "bravo" : "alpha" },
          scope: { agentId: agentId === "alpha" ? "bravo" : "alpha" },
          catalog: { models: [{ ...current, id: "foreign", name: "Other agent model" }] },
        });
        expect(await gateway.getRequests("models.list", { agentId })).toHaveLength(1);
        await gateway.emitGatewayEvent("models.snapshot", {
          target: hint ? { agentId: hint } : {},
          scope: { agentId },
          catalog: { models: [current], pendingProviders: ["fixture"] },
        });
        await gateway.emitGatewayEvent("models.snapshot", {
          target: { agentId: agentId === "alpha" ? "bravo" : "alpha" },
          scope: { agentId: agentId === "alpha" ? "bravo" : "alpha" },
          catalog: { models: [{ ...current, id: "foreign", name: "Other agent model" }] },
        });
        const trigger = page.locator("[data-chat-model-select]");
        const requestsBeforeOpen = (await gateway.getRequests("models.list")).length;
        await trigger.click();
        const currentRow = page.locator('[data-chat-model-option="fixture/current"]');
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect((await gateway.getRequests("models.list")).length - requestsBeforeOpen).toBe(0);
        expect(await page.locator("[data-chat-model-catalog-state]").textContent()).toContain(
          "fixture",
        );

        await gateway.resolveDeferred("models.list", { models: [older] });
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await page.locator('[data-chat-model-option="fixture/older"]').count()).toBe(0);
        expect(await page.locator('[data-chat-model-option="fixture/foreign"]').count()).toBe(0);
        await gateway.emitGatewayEvent("models.snapshot", {
          target: hint ? { agentId: hint } : {},
          scope: { agentId },
          catalog: { models: [older] },
        });
        await trigger.click();
        await trigger.click();
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await page.locator('[data-chat-model-option="fixture/older"]').count()).toBe(0);
        expect((await gateway.getRequests("models.list")).length - requestsBeforeOpen).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  it("keeps an ordinary catalog winner when its initial snapshot arrives later", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const current = { provider: "fixture", id: "current", name: "Current model", available: true };
    const older = { provider: "fixture", id: "older", name: "Older model", available: true };
    const gateway = await installMockGateway(page, {
      defaultAgentId: "alpha",
      agentModel: "fixture/current",
      heldMethods: ["models.list"],
      models: [older],
      methodResponses: {
        "agents.list": {
          defaultId: "alpha",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "alpha", name: "Alpha", model: { primary: "fixture/current" } }],
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("models.list", { match: { agentId: "alpha" } });
      await gateway.resolveDeferred("models.list", { models: [current] });
      const trigger = page.locator("[data-chat-model-select]");
      await trigger.click();
      const currentRow = page.locator('[data-chat-model-option="fixture/current"]');
      await expect.poll(() => currentRow.isVisible()).toBe(true);
      const count = (await gateway.getRequests("models.list")).length;
      await gateway.emitGatewayEvent("models.snapshot", {
        target: {},
        scope: { agentId: "alpha" },
        catalog: { models: [older] },
      });
      await trigger.click();
      await trigger.click();
      await expect.poll(() => currentRow.isVisible()).toBe(true);
      expect(await page.locator('[data-chat-model-option="fixture/older"]').count()).toBe(0);
      expect(await gateway.getRequests("models.list")).toHaveLength(count);
    } finally {
      await context.close();
    }
  });
});
