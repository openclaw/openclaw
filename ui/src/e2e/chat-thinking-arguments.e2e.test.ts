// Control UI E2E proves model-aware /think completion in the rendered composer.
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI thinking argument completion",
});

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
const key = "agent:main:main";
async function openComposer(page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) {
  await page.goto(`${suite.server.baseUrl}chat`);
  await gateway.waitForRequest("chat.startup");
  const composer = page.locator(".agent-chat__composer-combobox textarea");
  await composer.waitFor({ state: "visible" });
  await expect.poll(() => composer.isEnabled()).toBe(true);
  return composer;
}
const sessionList = (
  model: string,
  contextTokens: number | null,
  modelProvider?: string,
  ts = 1,
) => ({
  count: 1,
  path: "",
  ts,
  defaults: { model, modelProvider: "openai", contextTokens },
  sessions: [
    { key, kind: "direct", model, ...(modelProvider ? { modelProvider } : {}), updatedAt: ts },
  ],
});

suite.define(() => {
  it("keeps partial model thinking unknown and sends typed effort for server validation", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        agentModel: "openai/other",
        models: [
          {
            id: "model",
            name: "Model",
            provider: "openai",
            thinkingLevels: [{ id: "high", label: "High" }],
            thinkingDefault: "high",
          },
        ],
        methodResponses: {
          "sessions.list": {
            ...sessionList("model", null),
            defaults: { model: "other", modelProvider: "openai", contextTokens: null },
          },
        },
      });
      try {
        const composer = await openComposer(page, gateway);
        await composer.fill("/think");
        await composer.press("Tab");
        await expect.poll(() => composer.inputValue()).toBe("/think ");
        await composer.press("Enter");
        const log = page.getByRole("log");
        await expect.poll(() => log.textContent()).toContain("Current thinking level: Unknown.");
        expect(await log.textContent()).toContain("Options: Unknown.");
        expect(await page.locator('[data-chat-thinking-option="high"]').count()).toBe(0);
        expect(await page.locator('[data-chat-thinking-slider="true"]').count()).toBe(0);
        await composer.fill("/think low");
        await composer.press("Enter");
        expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
          key,
          thinkingLevel: "low",
        });
      } finally {
        await page.screenshot({ path: path.join(suite.artifactDir, "partial-thinking.png") });
      }
    });
  });

  it("executes a typed inline /elevated argument separately from the draft", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.send"],
      });

      const composer = await openComposer(page, gateway);

      await composer.fill("Keep this /elevated full");
      await composer.press("Enter");

      const request = await gateway.waitForRequest("chat.send");
      expect((request.params as { message?: unknown }).message).toBe("/elevated full");
      await expect.poll(() => composer.inputValue()).toBe("Keep this ");
    });
  });

  it("serializes a selected inline /exec host argument canonically", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.send"],
      });

      const composer = await openComposer(page, gateway);

      await composer.fill("Keep this /exec");
      await composer.press("Tab");
      await composer.press("Enter");

      const request = await gateway.waitForRequest("chat.send");
      expect((request.params as { message?: unknown }).message).toBe("/exec host=auto");
      await expect.poll(() => composer.inputValue()).toBe("Keep this ");
    });
  });

  it.each(VIEWPORTS)(
    "opens the active model's thinking levels above the composer ($name)",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const browserErrors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error") {
            browserErrors.push(message.text());
          }
        });
        page.on("pageerror", (error) => browserErrors.push(error.message));

        const gateway = await installMockGateway(page, {
          models: [
            {
              id: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              provider: "openai",
              thinkingLevels: [
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
                "ultra",
              ].map((id) => ({ id, label: id })),
            },
          ],
          methodResponses: {
            "sessions.list": sessionList("gpt-5.6-sol", 200_000, "openai", Date.now()),
          },
        });

        const composer = await openComposer(page, gateway);

        const thinking = page.locator('[data-chat-thinking-select="true"]');
        await thinking.waitFor({ state: "visible" });
        await expect.poll(() => thinking.getAttribute("data-chat-thinking-disabled")).toBe("false");
        await composer.fill("/think");
        await composer.press("Tab");

        const picker = page.locator(".slash-menu[role='listbox']");
        await picker.waitFor({ state: "visible" });
        await expect.poll(() => composer.inputValue()).toBe("/think ");
        await expect
          .poll(() => picker.getByRole("option").locator(".slash-menu-name").allTextContents())
          .toEqual(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

        const [pickerBox, inputBox] = await Promise.all([
          picker.boundingBox(),
          page.locator(".agent-chat__input").boundingBox(),
        ]);
        expect(pickerBox).not.toBeNull();
        expect(inputBox).not.toBeNull();
        expect((pickerBox?.y ?? 0) + (pickerBox?.height ?? 0)).toBeLessThanOrEqual(
          (inputBox?.y ?? 0) + 1,
        );
        expect(pickerBox?.x ?? -1).toBeGreaterThanOrEqual(0);
        expect((pickerBox?.x ?? 0) + (pickerBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
        expect(pickerBox?.y ?? -1).toBeGreaterThanOrEqual(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        expect(browserErrors).toEqual([]);

        await composer.press("ArrowUp");
        await composer.press("Tab");
        await expect.poll(() => composer.inputValue()).toBe("/think ultra");
        await composer.press("Enter");
        const patchRequest = await gateway.waitForRequest("sessions.patch");
        expect(patchRequest.params).toMatchObject({
          key: "agent:main:main",
          thinkingLevel: "ultra",
        });

        const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        const artifactDir = artifactRoot
          ? createControlUiE2eArtifactDir("chat-thinking-arguments", artifactRoot)
          : undefined;
        if (artifactDir) {
          await page.screenshot({
            path: path.join(artifactDir, `think-arguments-${viewport.name}.png`),
            fullPage: true,
          });
        }
      });
    },
  );
});
