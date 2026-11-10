import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette editor shortcuts" });

suite.define(() => {
  it.each([
    { platform: "MacIntel", modifier: "Meta", other: "Control", cold: "p" },
    { platform: "MacIntel", modifier: "Meta", other: "Control", cold: "Shift+p" },
    { platform: "Linux x86_64", modifier: "Control", other: "Meta", cold: "p" },
    { platform: "Linux x86_64", modifier: "Control", other: "Meta", cold: "Shift+p" },
  ])(
    "opens cold and loaded palettes with $modifier+$cold on $platform",
    async ({ platform, modifier, other, cold }) => {
      await suite.withPage({}, async ({ page }) => {
        await page.addInitScript((value) => {
          Object.defineProperty(navigator, "platform", { get: () => value });
          window.addEventListener("keydown", (event) => {
            Reflect.set(window, "lastShortcutPrevented", event.defaultPrevented);
          });
        }, platform);
        const sessionKey = "agent:main:dashboard:editor-shortcuts";
        await installMockGateway(page, { sessionKey });
        const module = await holdModuleResponse(
          page,
          controlUiE2eBuiltModuleRequest("ui/src/components/command-palette.tsx"),
        );
        try {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const composer = page.locator(".agent-chat__composer-combobox textarea:visible");
          await composer.fill("Keep this draft");
          const prevented = () => page.evaluate(() => Reflect.get(window, "lastShortcutPrevented"));
          for (const chord of [other + "+p", modifier + "+Alt+p", "p"]) {
            await page.keyboard.press(chord);
            expect(await prevented(), chord).toBe(false);
            expect(await page.locator(".cmd-palette__input").count()).toBe(0);
          }
          await composer.fill("Keep this draft");
          await page.keyboard.press(modifier + "+" + cold);
          expect(await prevented()).toBe(true);
          const input = page.locator(".cmd-palette__input");
          await input.waitFor({ state: "visible" });
          await module.request;
          await expect
            .poll(() => input.evaluate((element) => document.activeElement === element))
            .toBe(true);
          // The loading owner must consume the alias too, without waiting for the module.
          await page.keyboard.press(modifier + "+" + cold);
          expect(await prevented()).toBe(true);
          await input.waitFor({ state: "hidden" });
          module.release();
          await page.waitForFunction(() => customElements.get("openclaw-command-palette"));
          for (const chord of ["p", "Shift+p", "k"]) {
            await composer.focus();
            await page.keyboard.press(modifier + "+" + chord);
            expect(await prevented(), chord).toBe(true);
            await input.waitFor({ state: "visible" });
            await input.fill("Palette query");
            await page.keyboard.press(modifier + "+" + chord);
            expect(await prevented(), chord).toBe(true);
            await input.waitFor({ state: "hidden" });
            await expect
              .poll(() => composer.evaluate((element) => document.activeElement === element))
              .toBe(true);
            expect(await composer.inputValue()).toBe("Keep this draft");
          }
        } finally {
          module.release();
        }
      });
    },
  );
});
