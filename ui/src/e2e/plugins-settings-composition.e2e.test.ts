import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin settings input composition" });

suite.define(() => {
  it.each([
    { name: "composition flag", isComposing: true, keyCode: 27 },
    { name: "legacy composition key", isComposing: false, keyCode: 229 },
  ])("keeps $name Escape from saving an unfinished edit", async ({ name, ...keyboard }) => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.admin"],
        methodResponses: pluginResponses(),
      });
      const settingsUrl = `${suite.server.baseUrl}settings/plugins/workboard?view=settings`;
      await page.goto(settingsUrl);
      const label = page.getByRole("textbox", { name: "Workspace label", exact: true });
      await label.fill("日本語");
      await label.evaluate((element, init) => {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            ...init,
            key: "Escape",
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      }, keyboard);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.screenshot({ path: path.join(suite.artifactDir, `${name}.png`) });
      }
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      expect(page.url()).toBe(settingsUrl);
      expect(await label.inputValue()).toBe("日本語");
      expect(await label.evaluate((element) => element === document.activeElement)).toBe(true);
      await label.press("Tab");
      const save = await gateway.waitForRequest("config.set");
      expect(JSON.parse(String((save.params as { raw?: unknown }).raw))).toMatchObject({
        plugins: { entries: { workboard: { config: { workspaceLabel: "日本語" } } } },
      });
      expect(await gateway.getRequests("config.set")).toHaveLength(1);
    });
  });
});
