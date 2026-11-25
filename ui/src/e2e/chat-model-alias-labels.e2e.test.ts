import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model alias labels" });

suite.define(() => {
  it("hides redundant family aliases while keeping alias search and selection", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "claude-cli/opus",
        historyMessages: [],
        models: [
          { id: "opus", name: "Opus 5.5", alias: "opus", provider: "claude-cli" },
          { id: "sonnet", name: "Sonnet 5.5", alias: "sonnet", provider: "claude-cli" },
          { id: "opus-custom", name: "Opus 5.5", alias: "writing", provider: "claude-cli" },
        ],
        sessionInfo: { model: "opus", modelProvider: "claude-cli" },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__input").first();
      const picker = composer.locator(".chat-controls__model-picker");
      const trigger = picker.locator("[data-chat-model-select]");
      await expect.poll(() => trigger.textContent()).toContain("Opus 5.5");
      const opusButtonLabel = await trigger.textContent();
      await trigger.click();
      const opus = await revealChatModelOption(picker, "claude-cli/opus");
      const sonnet = await revealChatModelOption(picker, "claude-cli/sonnet");
      const writing = await revealChatModelOption(picker, "claude-cli/opus-custom");
      const labels = await picker.locator(".chat-controls__model-option-name").allTextContents();
      const frame = await takeControlUiScreenshotFrame(page, composer, [opus, sonnet, writing], {
        animations: "disabled",
        elements: [picker],
      });
      await writeFile(`${suite.artifactDir}/model-alias-labels.png`, frame.png);
      await writeFile(`${suite.artifactDir}/model-alias-labels-picker.png`, frame.elements[0]!.png);

      const search = picker.locator("[data-chat-model-search]");
      await search.fill("sonnet");
      await sonnet.waitFor({ state: "visible" });
      await expect.poll(() => opus.isVisible()).toBe(false);
      await sonnet.click();
      const patch = await gateway.waitForRequest("sessions.patch");
      expect(patch.params).toMatchObject({ model: "claude-cli/sonnet" });
      await expect.poll(() => trigger.textContent()).toContain("Sonnet 5.5");
      const sonnetButtonLabel = await trigger.textContent();

      await trigger.click();
      await search.fill("writing");
      await writing.waitFor({ state: "visible" });
      expect(await writing.locator(".chat-controls__model-option-name").textContent()).toBe(
        "Opus 5.5 · writing",
      );
      const customFrame = await takeControlUiScreenshotFrame(page, composer, [writing, search], {
        animations: "disabled",
        elements: [picker],
      });
      await writeFile(`${suite.artifactDir}/model-alias-custom-search.png`, customFrame.png);
      await writeFile(
        `${suite.artifactDir}/model-alias-custom-search-picker.png`,
        customFrame.elements[0]!.png,
      );
      const after = (await gateway.getRequests("sessions.patch")).length;
      await writing.click();
      const customPatch = await gateway.waitForRequest("sessions.patch", { after });
      expect(customPatch.params).toMatchObject({ model: "claude-cli/opus-custom" });
      await expect.poll(() => trigger.textContent()).toBe("Opus 5.5 · writing");
      expect(labels).toEqual(["Opus 5.5", "Sonnet 5.5", "Opus 5.5 · writing"]);
      expect(opusButtonLabel).toBe("Opus 5.5");
      expect(sonnetButtonLabel).toBe("Sonnet 5.5");
    });
  });
});
