import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it.each([1440, 390])(
    "keeps the empty model picker beside Dictate at %s pixels",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, colorScheme: "dark" },
        async ({ page }) => {
          const gateway = await installMockGateway(page, { models: [] });
          await page.goto(`${suite.server.baseUrl}new?agent=main`);
          await gateway.waitForRequest("models.list");
          const composer = page.locator(".new-session-page__composer");
          const trigger = composer.locator('[data-chat-model-select="true"]');
          const microphone = composer.getByRole("button", { name: "Dictate", exact: true });
          const measurements = [];
          for (const state of ["closed", "open", "closed-again"]) {
            if (state === "open") {
              await trigger.click();
              await page.locator(".chat-controls__model-menu").waitFor();
            } else if (state === "closed-again") {
              await page.keyboard.press("Escape");
              await page.locator(".chat-controls__model-menu").waitFor({ state: "hidden" });
            }
            await trigger.waitFor();
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              const frame = await takeControlUiScreenshotFrame(
                page,
                composer,
                [
                  trigger,
                  microphone,
                  ...(state === "open" ? [page.locator(".chat-controls__model-menu")] : []),
                ],
                {
                  animations: "disabled",
                  animationFrameBeforeCapture: true,
                },
              );
              await writeFile(path.join(suite.artifactDir, `${width}-${state}.png`), frame.png);
            }
            const modelBox = await trigger.boundingBox();
            const microphoneBox = await microphone.boundingBox();
            expect(modelBox).not.toBeNull();
            expect(microphoneBox).not.toBeNull();
            measurements.push({ state, gap: microphoneBox!.x - modelBox!.x - modelBox!.width });
          }
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await writeFile(
              path.join(suite.artifactDir, `${width}-measurements.json`),
              JSON.stringify(measurements),
            );
          }
          for (const { state, gap } of measurements) {
            expect(gap, `${state}: model-to-microphone gap`).toBeGreaterThanOrEqual(0);
            expect(gap, `${state}: model-to-microphone gap`).toBeLessThanOrEqual(
              width < 480 ? 32 : 8,
            );
            expect(
              Math.abs(gap - measurements[0]!.gap),
              `${state}: opening must not add blank space`,
            ).toBeLessThanOrEqual(1);
          }
        },
      );
    },
  );
});
