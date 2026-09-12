import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette first open" });

async function readPaletteBackdrop(page: import("playwright").Page) {
  return await page.locator("openclaw-modal-dialog.cmd-palette-overlay").evaluate((modal) => {
    const dialog = modal.shadowRoot
      ?.querySelector("wa-dialog")
      ?.shadowRoot?.querySelector("dialog");
    if (!(dialog instanceof HTMLDialogElement)) {
      throw new Error("Expected the command palette dialog");
    }
    const style = getComputedStyle(dialog, "::backdrop");
    const alphaMatch = style.backgroundColor.match(/\/\s*([\d.]+)\s*\)$/u);
    return {
      alpha: alphaMatch ? Number(alphaMatch[1]) : style.backgroundColor === "transparent" ? 0 : 1,
      filter: style.backdropFilter,
    };
  });
}

suite.define(() => {
  it.each([
    { height: 900, width: 1280 },
    { height: 844, width: 390 },
  ])("shows the palette shell while its module loads at $width px", async (viewport) => {
    await suite.withPage({ viewport }, async ({ page }) => {
      await installMockGateway(page);
      const paletteModule = await holdModuleResponse(
        page,
        /\/assets\/command-palette-[^/?]+\.js(?:\?.*)?$/u,
      );
      // Keep an unrelated route loader present so palette assertions cannot depend on it.
      const chatModule = await holdModuleResponse(
        page,
        /\/assets\/chat-page-[^/?]+\.js(?:\?.*)?$/u,
      );
      await page.goto(`${suite.server.baseUrl}chat?session=main`);

      try {
        // Navigation can finish before the shell installs its shortcut handler.
        await page.locator(".shell").waitFor({ state: "visible" });
        await page.keyboard.press("Control+K");

        const shell = page.locator(".cmd-palette");
        await shell.waitFor({ state: "visible" });
        await paletteModule.request;
        expect(await shell.getAttribute("aria-label")).toBe("Loading…");
        const loadingBackdrop = await readPaletteBackdrop(page);
        expect(loadingBackdrop.filter).toBe("none");
        expect(loadingBackdrop.alpha).toBeLessThanOrEqual(0.2);
        await page
          .locator("openclaw-router-outlet .lazy-view-state--loading")
          .waitFor({ state: "attached" });
        expect(await shell.locator(".lazy-view-state--loading").count()).toBe(0);

        chatModule.release();
        paletteModule.release();
        await page.locator(".cmd-palette__input:not([disabled])").waitFor({ state: "visible" });
        const loadedBackdrop = await readPaletteBackdrop(page);
        expect(loadedBackdrop.filter).toBe("none");
        expect(loadedBackdrop.alpha).toBeLessThanOrEqual(0.2);
      } finally {
        paletteModule.release();
        chatModule.release();
      }
    });
  });
});
