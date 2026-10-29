import { afterAll, beforeAll, expect, it } from "vitest";
import {
  captureScreenshot,
  describeControlUiE2e,
  enabledWorkboardCapabilities,
  installMockGateway,
  mobileViewport,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "../../plugins/plugins.e2e.test-support.ts";

// Exercise the application store, subscription and mounted transcript together.
// The Gateway publishes the same event for every plugin install entry point.
describeControlUiE2e("Chat plugin installation status", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("updates mounted recommendations without navigation or reconnect", async () => {
    const context = await newContext(mobileViewport);
    const page = await context.newPage();
    const recommendations = ["calendar", "notes"].map((id) => ({
      type: "clawhub",
      kind: "plugin",
      id: "ch_" + id,
      name: id === "calendar" ? "Calendar" : "Notes",
      official: true,
      installed: false,
    }));
    const details = (installed: boolean) => ({
      cases: recommendations.map((card) => ({
        match: { id: card.id },
        response: {
          plugin: {
            id: card.id,
            catalog: { name: card.name, official: true, categories: [] },
            local: { installed, action: installed ? "manage" : "install" },
          },
        },
      })),
    });
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      historyMessages: [
        { role: "assistant", content: recommendations, timestamp: 1_780_000_000_000 },
      ],
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.get": details(false),
      },
    });
    try {
      await page.goto(server.baseUrl + "chat");
      const cards = page.locator("openclaw-chat-clawhub-card");
      await expect.poll(() => cards.locator(".chat-clawhub-card__install").count()).toBe(2);
      await expect.poll(() => cards.locator(".chat-clawhub-card__dismiss").count()).toBe(2);
      const mounted = await cards.first().elementHandle();
      const connects = (await gateway.getRequests("connect")).length;
      await captureScreenshot(page, "chat-plugin-cards-before.png", "viewport");
      await gateway.setMethodResponse("plugins.catalog.get", details(true));
      await gateway.setMethodResponse("plugins.uiDescriptors", enabledWorkboardCapabilities());
      await gateway.emitGatewayEvent("plugins.changed", { generation: 1 });
      await expect.poll(() => cards.locator(".chat-clawhub-card__installed").count()).toBe(2);
      expect(await cards.locator(".chat-clawhub-card__install").count()).toBe(0);
      expect(await cards.locator(".chat-clawhub-card__dismiss").count()).toBe(0);
      expect(await mounted!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
      await captureScreenshot(page, "chat-plugin-cards-after.png", "viewport");
    } finally {
      await context.close();
    }
  });
});
