import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Auto routing preference and input",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("persists the real pane toggle and sends Auto without changing the queue baseline", async () => {
    await suite.withPage({ viewport: { width: 520, height: 900 } }, async ({ page }) => {
      const config = {
        agents: {
          defaults: {
            model: "example/plain",
            decisionModel: "typesafe/jev-latest",
            experimental: { decisionAssistance: true },
          },
        },
        messages: { queue: { mode: "followup" } },
      };
      const gateway = await installMockGateway(page, {
        agentModel: "example/plain",
        models: [
          {
            id: "plain",
            provider: "example",
            name: "Plain model",
            reasoning: false,
            thinkingLevels: [],
          },
        ],
        sessionInfo: { model: "plain", modelProvider: "example" },
        historyMessages: [{ role: "user", content: "Write a CSV parser." }],
        methodResponses: {
          "config.get": {
            config,
            runtimeConfig: config,
            sourceConfig: config,
            hash: "auto-fixture",
            valid: true,
            raw: JSON.stringify(config),
            issues: [],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const composer = page.locator(".agent-chat__input").first();
      const effort = composer.locator("[data-chat-thinking-select]");
      await expect.poll(() => effort.getAttribute("aria-disabled")).toBe("false");
      await effort.click();
      const auto = composer.locator("[data-chat-auto-steer-toggle]");
      await expect.poll(() => auto.getAttribute("aria-checked")).toBe("false");
      await auto.focus();
      await page.keyboard.press("Space");
      await expect.poll(() => auto.getAttribute("aria-checked")).toBe("true");
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
      expect(await gateway.getRequests("chat.send")).toEqual([]);
      await page.reload();
      await effort.click();
      await expect.poll(() => auto.getAttribute("aria-checked")).toBe("true");
      await page.keyboard.press("Escape");
      // Establish the active turn through the same UI lifecycle as a real send;
      // a synthetic history hint alone is not an active-turn receipt.
      await composer.locator("textarea").fill("Start a CSV parser task.");
      await composer.locator("textarea").press("Enter");
      await gateway.waitForRequest("chat.send");
      await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
      const startedCount = (await gateway.getRequests("chat.send")).length;
      await composer.locator("textarea").fill("Also handle escaped commas.");
      await composer.locator("textarea").press("Enter");
      const request = await gateway.waitForRequest("chat.send", { after: startedCount });
      expect(request.params).toMatchObject({
        message: "Also handle escaped commas.",
        deliveryPolicy: "auto",
      });
      // Inherited policy stays unset on the wire; only an explicit browser
      // Queue/Steer choice becomes an override. The Gateway owns its default.
      expect(request.params).not.toHaveProperty("queueMode");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  });
});
