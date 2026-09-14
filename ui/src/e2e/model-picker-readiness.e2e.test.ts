import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model picker history readiness" });
suite.define(() => {
  it("waits for composer admission after the Gateway handshake", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const model = { id: "gpt-5.4", provider: "openai", name: "GPT-5.4", available: true };
      const gateway = await installMockGateway(page, {
        agentModel: "openai/gpt-5.4",
        models: [model],
        deferredMethods: ["chat.startup"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiGatewayReady(page);
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__input").first();
      const trigger = composer.locator("[data-chat-model-select]");
      const picker = composer.locator(".chat-controls__model-picker");
      await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("true");
      await trigger.click();
      expect(await picker.getAttribute("open")).toBeNull();
      await gateway.resolveDeferred("chat.startup");
      await expect.poll(() => trigger.getAttribute("aria-disabled")).toBe("false");
      await trigger.click();
      await expect
        .poll(() => composer.locator('[data-chat-model-option="openai/gpt-5.4"]').isVisible())
        .toBe(true);
    });
  });
});
