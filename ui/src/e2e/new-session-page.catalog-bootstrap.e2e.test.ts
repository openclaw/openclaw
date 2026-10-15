import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([
    { route: "new?agent=alpha", agentId: "alpha" },
    { route: "new?agent=bravo", agentId: "bravo" },
    { route: "new", agentId: "alpha" },
    { route: "new?agent=missing", agentId: "alpha" },
  ])(
    "opens $route for $agentId with one ordinary catalog read despite saved bravo selection",
    async ({ route, agentId }) => {
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
        heldMethods: ["agents.list", "models.list"],
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
        expect(connected.params).not.toHaveProperty("modelCatalog");
        await gateway.waitForRequest("agents.list");
        await page.waitForFunction(
          (expectedAgentId) => {
            const element = document.querySelector("openclaw-new-session-page");
            return (
              element &&
              "data" in element &&
              (element.data as { requestedAgentId?: string } | undefined)?.requestedAgentId ===
                expectedAgentId
            );
          },
          new URL(route, suite.server.baseUrl).searchParams.get("agent") ?? "",
        );
        await gateway.resolveDeferred("agents.list");
        await gateway.waitForRequest("models.list", { match: { agentId } });
        await expect.poll(() => page.locator(".new-session-page__message").isVisible()).toBe(true);
        await gateway.resolveDeferred("models.list", {
          models: [current],
          pendingProviders: ["fixture"],
        });
        const trigger = page.locator("[data-chat-model-select]");
        const requestsBeforeOpen = (await gateway.getRequests("models.list")).length;
        await trigger.click();
        const currentRow = page.locator('[data-chat-model-option="fixture/current"]');
        await revealChatModelOption(currentRow);
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect((await gateway.getRequests("models.list")).length - requestsBeforeOpen).toBe(0);
        expect(await page.locator("[data-chat-model-refresh]").textContent()).toContain(
          "Refreshing models for Fixture…",
        );
        expect(await page.locator("[data-chat-model-catalog-state]").count()).toBe(0);

        const catalogRequests = await gateway.getRequests("models.list");
        expect(catalogRequests, JSON.stringify(catalogRequests, null, 2)).toHaveLength(1);
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await page.locator('[data-chat-model-option="fixture/older"]').count()).toBe(0);
        await trigger.click();
        await trigger.click();
        await revealChatModelOption(currentRow);
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await page.locator('[data-chat-model-option="fixture/older"]').count()).toBe(0);
        expect((await gateway.getRequests("models.list")).length - requestsBeforeOpen).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  it("reloads the current catalog without losing its draft", async () => {
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
      await gateway.waitForRequest("connect");
      await gateway.waitForRequest("models.list", { match: { agentId: "alpha" } });
      await gateway.resolveDeferred("models.list", { models: [current] });
      const message = page.locator(".new-session-page__message");
      await message.fill("Keep this catalog draft");
      await waitForCommittedComposerDraft(
        page,
        JSON.stringify(["", "", ""]),
        "Keep this catalog draft",
        0,
      );
      const trigger = page.locator("[data-chat-model-select]");
      await trigger.click();
      const currentRow = page.locator('[data-chat-model-option="fixture/current"]');
      await revealChatModelOption(currentRow);
      await expect.poll(() => currentRow.isVisible()).toBe(true);
      await page.reload();
      await gateway.waitForRequest("connect");
      const reloaded = await gateway.waitForRequest("models.list", { match: { agentId: "alpha" } });
      expect(reloaded.params).toMatchObject({ agentId: "alpha" });
      await gateway.resolveDeferred("models.list", { models: [current] });
      await trigger.click();
      await revealChatModelOption(currentRow);
      await expect.poll(() => currentRow.isVisible()).toBe(true);
      expect(await page.locator('[data-chat-model-option="fixture/older"]').count()).toBe(0);
      expect(await message.inputValue()).toBe("Keep this catalog draft");
    } finally {
      await context.close();
    }
  });
});
