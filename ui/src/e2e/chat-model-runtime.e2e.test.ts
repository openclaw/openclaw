import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatModelPicker, revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { modelPicker, runtimeModel } from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model runtime selection" });

suite.define(() => {
  it("shows each runtime's own name and context budget", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const model = runtimeModel("gpt-5.6-sol", "openai", "GPT-5.6 Sol", [], {
        contextWindow: 1_000_000,
        runtimeChoices: [
          {
            agentRuntime: { id: "codex", source: "model" },
            available: true,
            contextWindow: 200_000,
          },
        ],
      });
      await installMockGateway(page, { agentModel: "openai/gpt-5.6-sol", models: [model] });
      await page.goto(`${suite.server.baseUrl}chat`);
      const { picker, runtime } = modelPicker(page);
      await openChatModelPicker(picker);
      for (const [id, name, context] of [
        ["codex", "GPT-5.6 Sol codex", "200k · Codex"],
        ["openclaw", "GPT-5.6 Sol", "1M · OpenClaw"],
      ] as const) {
        const option = runtime(id);
        await revealChatModelOption(picker, "openai/gpt-5.6-sol", { runtime: id });
        expect(await option.locator(".chat-controls__model-option-name").textContent()).toBe(name);
        expect(await option.textContent()).toContain(context);
      }
    });
  });
});
