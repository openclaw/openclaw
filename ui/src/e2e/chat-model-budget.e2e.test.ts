import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Configured model budget" });

suite.define(() => {
  it("shows the configured budget alongside the maximum in the model picker", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const models = ["astra", "sol"].map((id) => ({
        id,
        name: id,
        provider: "example",
        contextWindow: 128_000,
        contextTokens: 96_000,
      }));
      await installMockGateway(page, {
        agentModel: "example/astra",
        models,
        methodResponses: { "models.list": { models } },
      });
      await page.goto(suite.server.baseUrl + "new");
      const picker = page.locator(".agent-chat__input .chat-controls__model-picker").first();
      const option = picker.locator('[data-chat-model-option="example/sol"]');
      await expect.poll(() => option.count()).toBe(1);
      await picker.locator("[data-chat-model-select]").click();
      await revealChatModelOption(option);
      await option.waitFor({ state: "visible" });
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
        const directory = createControlUiE2eArtifactDir("configured-model-budget");
        const frame = await takeControlUiScreenshotFrame(page, picker, [option], {
          animations: "disabled",
          elements: [option],
        });
        await writeFile(directory + "/viewport.png", frame.png);
        await writeFile(directory + "/model-row.png", frame.elements[0]!.png);
      }
      expect(await option.textContent()).toContain("96k active · 128k max");
    });
  });
});
