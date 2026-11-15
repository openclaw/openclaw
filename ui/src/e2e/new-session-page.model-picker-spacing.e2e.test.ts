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
  it.each([1440, 390])("fits the model chip to its label at %s pixels", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 900 }, colorScheme: "light" },
      async ({ page }) => {
        const models = [
          { id: "short", name: "GPT 5.5", provider: "openai" },
          { id: "long", name: "A deliberately long model display name", provider: "openai" },
        ];
        await installMockGateway(page, { agentModel: "openai/short", models });
        await page.goto(`${suite.server.baseUrl}new?agent=main`);
        const composer = page.locator(".new-session-page__composer");
        const trigger = composer.locator("[data-chat-model-select]");
        const label = trigger.locator(".chat-controls__inline-select-label");
        await expect.poll(() => label.textContent()).toBe(models[0]!.name);
        await composer.locator("textarea").fill("Help me plan the next release.");
        for (const id of ["short", "long", "short"]) {
          await trigger.click();
          await page.locator(`[data-chat-model-option="openai/${id}"]`).click();
          await expect
            .poll(() => label.textContent())
            .toBe(models.find((model) => model.id === id)!.name);
          await page.locator(".chat-controls__model-menu").waitFor({ state: "hidden" });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const frame = await takeControlUiScreenshotFrame(page, composer, [trigger, label], {
              animations: "disabled",
              elements: [composer],
            });
            await writeFile(path.join(suite.artifactDir, `${width}-${id}-page.png`), frame.png);
            await writeFile(
              path.join(suite.artifactDir, `${width}-${id}-composer.png`),
              frame.elements[0]!.png,
            );
          }
          const geometry = await trigger.evaluate((element) => {
            const labelElement = element.querySelector(".chat-controls__inline-select-label")!;
            const chevron = element.querySelector(".chat-controls__inline-select-chevron")!;
            const range = document.createRange();
            range.selectNodeContents(labelElement);
            return {
              gap:
                chevron.getBoundingClientRect().left -
                Math.min(
                  range.getBoundingClientRect().right,
                  labelElement.getBoundingClientRect().right,
                ),
              clipped: labelElement.scrollWidth > labelElement.clientWidth,
              textOverflow: getComputedStyle(labelElement).textOverflow,
            };
          });
          expect(geometry.gap).toBeGreaterThanOrEqual(0);
          expect(geometry.gap).toBeLessThanOrEqual(8);
          expect(geometry.clipped).toBe(id === "long");
          expect(geometry.textOverflow).toBe("ellipsis");
        }
      },
    );
  });
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
