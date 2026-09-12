import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    {
      route: "chat/alpha/~key/session-one",
      sessionKey: "agent:alpha:session-one",
      target: { agentId: "alpha", sessionKey: "agent:alpha:session-one" },
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha",
      sessionKey: "agent:alpha:main",
      target: { agentId: "alpha", sessionKey: "agent:alpha:main" },
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha/abcdef12",
      sessionKey: "agent:alpha:dm:abcdef1234567890abcdef1234567890",
      target: { agentId: "alpha", shortId: "abcdef12" },
      sessionScope: "per-sender" as const,
    },
    {
      route: "chat/alpha",
      sessionKey: "global",
      target: { agentId: "alpha", sessionKey: "agent:alpha:main" },
      sessionScope: "global" as const,
    },
  ])(
    "opens $route ($sessionKey) from its session snapshot while an older reply is held",
    async ({ route, sessionKey, target, sessionScope }) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      const current = {
        provider: "fixture",
        id: "session-current",
        name: "Session model",
        available: true,
      };
      const older = { ...current, id: "older", name: "Older model" };
      const foreign = { ...current, id: "foreign", name: "Another context's model" };
      const scope = { agentId: "alpha", sessionKey };
      const gateway = await installMockGateway(page, {
        defaultAgentId: "alpha",
        sessionKey,
        sessionScope,
        mainSessionKey: sessionScope === "global" ? "global" : "agent:alpha:main",
        agentModel: "fixture/session-current",
        sessionInfo: { model: current.id, modelProvider: current.provider },
        models: [older],
        heldMethods: ["models.list"],
        presenceUsers: [{ id: "fixture-person", name: "Fixture Person", self: true }],
        methodResponses: {
          "sessions.list": {
            ts: 1,
            path: "",
            count: 1,
            sessions: [
              {
                key: sessionKey,
                sessionId: "fixture-session",
                kind: "direct",
                updatedAt: 1,
                model: current.id,
                modelProvider: current.provider,
              },
            ],
            defaults: { model: current.id, modelProvider: current.provider, contextTokens: null },
          },
          "models.list": {
            models: [older],
            accountSelection: { kind: "automatic", label: "Automatic" },
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}${route}`);
        const connect = await gateway.waitForRequest("connect");
        expect(connect.params).toMatchObject({ modelCatalog: target });
        await expect
          .poll(async () => (await gateway.getRequests("models.list", scope)).length)
          .toBe(1);
        // The chat's delayed child roster request is startup work, independent of the picker.
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
        for (const otherScope of [
          { agentId: "alpha" },
          { agentId: "alpha", sessionKey: "agent:alpha:other" },
          { agentId: "bravo", sessionKey: "agent:bravo:session-one" },
        ]) {
          await gateway.emitGatewayEvent("models.snapshot", {
            scope: otherScope,
            catalog: { models: [foreign] },
          });
        }
        expect(await gateway.getRequests("models.list", scope)).toHaveLength(1);
        await gateway.emitGatewayEvent("models.snapshot", {
          scope: "shortId" in target ? scope : target,
          catalog: {
            models: [current],
            pendingProviders: ["fixture"],
            accountSelection: {
              kind: "personal",
              authProfileId: "personal:fixture-person:fixture:one",
              label: "Pinned session account",
              source: "user",
            },
          },
        });
        const picker = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .chat-controls__model-picker',
        );
        const trigger = picker.locator("[data-chat-model-select]");
        const currentRow = picker.locator('[data-chat-model-option="fixture/session-current"]');
        const requestsBeforeOpen = (await gateway.getRequests("models.list")).length;
        const sessionRequestsBeforeOpen = (await gateway.getRequests("sessions.list")).length;
        await trigger.click();
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await picker.textContent()).toContain("Pinned session account");
        expect(await picker.locator("[data-chat-model-catalog-state]").textContent()).toContain(
          "fixture",
        );
        expect(await gateway.getRequests("models.list")).toHaveLength(requestsBeforeOpen);
        expect(await gateway.getRequests("sessions.list")).toHaveLength(sessionRequestsBeforeOpen);
        await gateway.resolveDeferred("models.list", { models: [older] });
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(
          await picker
            .locator(
              '[data-chat-model-option="fixture/older"], [data-chat-model-option="fixture/foreign"]',
            )
            .count(),
        ).toBe(0);
        expect(await picker.textContent()).toContain("Pinned session account");
        await trigger.click();
        await trigger.click();
        await expect.poll(() => currentRow.isVisible()).toBe(true);
        expect(await gateway.getRequests("models.list")).toHaveLength(requestsBeforeOpen);
        expect(await gateway.getRequests("sessions.list")).toHaveLength(sessionRequestsBeforeOpen);
      } finally {
        await context.close();
      }
    },
  );
});
