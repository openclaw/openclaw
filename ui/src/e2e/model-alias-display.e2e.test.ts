import { expect, it } from "vitest";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const model = (provider: string, id: string, name: string, alias: string) => ({
  provider,
  id,
  name,
  alias,
});
const models = [
  model("anthropic", "claude-opus-4-8", "Opus 4.8", "opus"),
  model("anthropic", "claude-sonnet-5", "Sonnet 5", "sonnet"),
  model("nvidia", "moonshotai/kimi-k2.5", "Kimi K2.5", "Kimi K2.5 (NVIDIA)"),
];

const contextOptions = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { height: 900, width: 1280 },
} as const;

suite.define(() => {
  it("keeps model versions and custom aliases visible in the chat picker", async () => {
    await suite.withPage(contextOptions, async ({ page }) => {
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
      const sonnet = option("anthropic/claude-sonnet-5");
      await revealChatModelOption(main, "anthropic/claude-opus-4-8");
      await expect.poll(() => opus.textContent()).toBe("Opus 4.8 · opus");
      await expect.poll(() => sonnet.textContent()).toBe("Sonnet 5 · sonnet");

      const nvidia = option("nvidia/moonshotai/kimi-k2.5");
      await revealChatModelOption(main, "nvidia/moonshotai/kimi-k2.5");
      await expect.poll(() => nvidia.textContent()).toBe("Kimi K2.5");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
});
