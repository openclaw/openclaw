import { expect, it } from "vitest";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

const model = (provider: string, id: string, name: string, alias: string) => ({
  provider,
  id,
  name,
  alias,
});
const models = [
  model("anthropic", "claude-opus-4-8", "Opus 4.8", "opus"),
  model("nvidia", "moonshotai/kimi-k2.5", "Kimi K2.5", "Kimi K2.5 (NVIDIA)"),
];

suite.define(() => {
  it("keeps model versions and custom aliases visible in the chat picker", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["models.list", "chat.startup", "sessions.patch"],
        models,
        sessionKey: "agent:main:main",
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const main = page.getByRole("main");
      const picker = main.locator('[data-chat-model-select="true"]').first();
      await picker.waitFor({ state: "visible", timeout: 10_000 });
      await picker.click();

      const option = (ref: string) =>
        main.locator(`[data-chat-model-option="${ref}"] .chat-controls__model-option-name`);
      const opus = option("anthropic/claude-opus-4-8");
      await revealChatModelOption(main, "anthropic/claude-opus-4-8");
      await expect.poll(() => opus.textContent()).toBe("Opus 4.8 · opus");

      const nvidia = option("nvidia/moonshotai/kimi-k2.5");
      await revealChatModelOption(main, "nvidia/moonshotai/kimi-k2.5");
      await expect.poll(() => nvidia.textContent()).toBe("Kimi K2.5");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
});
