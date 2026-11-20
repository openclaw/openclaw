import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Unconfigured model in Chat" });

suite.define(() => {
  it("keeps an unconfigured default out of the picker and guides unsent drafts to setup", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-6-astra",
          sessionInfo: { model: "gpt-6-astra", modelProvider: "openai", modelOverrideSource: null },
          models: [
            { id: "gpt-6-astra", name: "GPT-6-Astra", provider: "openai", available: false },
          ],
          methodResponses: { "models.authStatus": { ts: 1, providers: [] } },
        });
        await page.goto(new URL("chat", suite.server.baseUrl).href);
        const setup = page.locator("[data-chat-model-setup]").first();
        await setup.waitFor();
        expect(await page.locator("[data-chat-model-select]").count()).toBe(0);
        expect(await page.locator("[data-chat-model-option]").count()).toBe(0);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator("openclaw-app"),
          [setup],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "picker.png"), frame.png);
        expect(await setup.textContent()).toContain("Set up a model");
        const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
        await composer.fill("Hello");
        await composer.press("Enter");
        expect((await composer.inputValue()).trimEnd()).toBe("Hello");
        expect(await page.locator(".chat-send-btn--send").isDisabled()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await setup.waitFor();
        const sendFrame = await takeControlUiScreenshotFrame(
          page,
          page.locator("openclaw-app"),
          [setup, composer],
          { animations: "disabled" },
        );
        await writeFile(path.join(suite.artifactDir, "send.png"), sendFrame.png);
        await setup.click();
        await page.waitForURL((url) => url.pathname.endsWith("/settings/model-providers"));
      },
    );
  });
});
