import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import { sessionRow } from "./chat-flow-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Chat model picker Speed",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it.each([
    { width: 1280, chooseFast: true },
    { width: 420, chooseFast: false },
  ])(
    "switches providers and chooses Fast=$chooseFast at $width px",
    async ({ width, chooseFast }) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, locale: "en-US" },
        async ({ page }) => {
          const key = "agent:main:main";
          const gpt = "openai/gpt-5.5";
          const claude = "anthropic/claude-opus-4-6";
          const gateway = await installMockGateway(page, {
            sessionKey: key,
            agentModel: gpt,
            sessions: [
              sessionRow(key, "Release notes", 1, {
                model: "gpt-5.5",
                modelProvider: "openai",
                fastMode: true,
              }),
            ],
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                provider: "openai",
                supportsFastMode: true,
                contextWindow: 272000,
                available: true,
              },
              {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                provider: "anthropic",
                supportsFastMode: true,
                contextWindow: 200000,
                available: true,
              },
            ],
          });
          const patches = async () =>
            (await gateway.getRequests("sessions.patch")).map(({ params }) => params);
          await page.goto(new URL("chat", suite.server.baseUrl).href);
          const trigger = page.locator("[data-chat-model-select]");
          const openPicker = async () => {
            if (width === 420) {
              await page.locator(".agent-chat__input textarea").click();
            }
            await trigger.click();
          };
          await expect.poll(() => trigger.textContent()).toContain("GPT-5.5");
          await openPicker();
          const claudeRow = await revealChatModelOption(page, claude);
          expect(await claudeRow.textContent()).toContain("Standard");
          await claudeRow.click();
          await expect.poll(() => trigger.textContent()).toContain("Claude Opus 4.6");
          await expect
            .poll(patches)
            .toContainEqual(expect.objectContaining({ model: claude, fastMode: null }));
          await openPicker();
          const gptRow = await revealChatModelOption(page, gpt);
          const remembered = gptRow.locator("[data-chat-model-last-speed]");
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const menu = page.locator(".chat-controls__model-menu:visible");
            const frame = await takeControlUiScreenshotFrame(page, menu, [gptRow], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, `model-speed-picker-${width}.png`),
              frame.png,
            );
          }
          expect(await gptRow.locator(".chat-controls__model-speed").textContent()).toBe(
            "Standard",
          );
          expect(await remembered.textContent()).toBe("Use Fast");
          expect(await remembered.getAttribute("aria-label")).toBe(
            "Use Fast on GPT-5.5 (last used)",
          );
          expect(await patches()).not.toContainEqual(expect.objectContaining({ fastMode: true }));
          if (chooseFast) {
            await remembered.press("Enter");
            await expect
              .poll(patches)
              .toContainEqual(expect.objectContaining({ model: null, fastMode: true }));
          } else {
            await gptRow.locator(".chat-controls__model-option-name").click();
            await expect.poll(patches).toContainEqual(expect.objectContaining({ model: null }));
            expect(await patches()).not.toContainEqual(expect.objectContaining({ fastMode: true }));
          }
          await expect.poll(() => trigger.textContent()).toContain("GPT-5.5");
          await expect
            .poll(() =>
              page.locator("[data-chat-thinking-select]").getAttribute("data-chat-fast-mode"),
            )
            .toBe(String(chooseFast));
        },
      );
    },
  );
});
