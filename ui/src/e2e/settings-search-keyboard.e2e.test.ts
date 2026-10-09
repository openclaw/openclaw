import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings search keyboard ownership" });

suite.define(() => {
  it.each([
    { name: "composition flag", query: "日本語", isComposing: true, keyCode: 27 },
    { name: "legacy composition key", query: "日本語", isComposing: false, keyCode: 229 },
    { name: "empty composition", query: "", isComposing: true, keyCode: 27 },
  ])("leaves $name Escape with the input method", async ({ name, query, ...keyboard }) => {
    await suite.withPage(
      { locale: "ja-JP", colorScheme: "dark", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        const settingsUrl = `${suite.server.baseUrl}settings/appearance`;
        await page.goto(settingsUrl);
        const search = page.locator(".settings-sidebar__search-input");
        await search.fill(query);
        await search.focus();
        const prevented = await search.evaluate((element, init) => {
          const event = new KeyboardEvent("keydown", {
            ...init,
            key: "Escape",
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        }, keyboard);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`) });
        }
        expect(page.url()).toBe(settingsUrl);
        expect(await search.inputValue()).toBe(query);
        expect(prevented).toBe(false);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
      },
    );
  });
});
