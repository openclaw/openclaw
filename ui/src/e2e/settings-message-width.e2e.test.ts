import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings message width" });

suite.define(() => {
  it("retains the last valid reading width when CSS math is mistyped", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [{ role: "assistant", content: "A comfortable reading column." }],
      });
      const settingsUrl = `${suite.server.baseUrl}settings/appearance#settings-appearance-chat`;
      const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      const storedWidth = () =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatMessageMaxWidth,
          settingsKey,
        );
      const widthInput = page.getByRole("textbox", { name: "Message width", exact: true });
      await page.goto(settingsUrl);
      await widthInput.fill("  min(768px,   82%)  ");
      await widthInput.press("Tab");
      await browserExpect.poll(storedWidth).toBe("min(768px, 82%)");

      await widthInput.fill("calc(100%-2rem)");
      await widthInput.press("Tab");
      const rejected = await widthInput.evaluate((input: HTMLInputElement) => ({
        value: input.value,
        invalid: input.validity.customError,
        message: input.validationMessage,
      }));
      const storedAfterTypo = await storedWidth();
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
        await page.screenshot({ path: path.join(suite.artifactDir, "settings-typo.png") });
      }
      await page.reload();
      await widthInput.waitFor();
      const restoredWidth = await widthInput.inputValue();
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const transcript = page.locator(".chat-thread-inner");
      await transcript.getByText("A comfortable reading column.").waitFor();
      const rendered = await transcript.evaluate((element) => ({
        maxWidth: getComputedStyle(element).maxWidth,
        width: element.getBoundingClientRect().width,
      }));
      if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
        await page.screenshot({ path: path.join(suite.artifactDir, "chat-after-typo.png") });
        writeFileSync(
          path.join(suite.artifactDir, "width-outcome.json"),
          JSON.stringify({ rejected, storedAfterTypo, restoredWidth, rendered }, null, 2),
        );
      }
      expect.soft(rejected.invalid).toBe(true);
      expect.soft(rejected.message).toContain("Enter a CSS width");
      expect.soft(storedAfterTypo).toBe("min(768px, 82%)");
      expect.soft(restoredWidth).toBe("min(768px, 82%)");
      expect.soft(rendered.maxWidth).toBe("min(768px, 82%)");

      await page.goto(settingsUrl);
      await widthInput.fill("clamp(400px, 80%)");
      await widthInput.press("Tab");
      expect(
        await widthInput.evaluate((input: HTMLInputElement) => input.validity.customError),
      ).toBe(true);
      await widthInput.fill("calc(100% - 2rem)");
      await widthInput.press("Tab");
      await browserExpect.poll(storedWidth).toBe("calc(100% - 2rem)");
      await browserExpect(widthInput).toHaveJSProperty("validationMessage", "");
      await page.reload();
      await browserExpect(widthInput).toHaveValue("calc(100% - 2rem)");

      await widthInput.fill("");
      await widthInput.press("Tab");
      await browserExpect.poll(storedWidth).toBeUndefined();
      await page.reload();
      await browserExpect(widthInput).toHaveValue("");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await transcript.getByText("A comfortable reading column.").waitFor();
      expect(await transcript.evaluate((element) => getComputedStyle(element).maxWidth)).toBe(
        "768px",
      );
    });
  });
});
