import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pluginResponses, configMocks } from "./plugins-settings-admin.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Plugin settings failed-read loading audit",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("does not keep claiming loading after a first configuration read fails", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 1000 },
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const message = "Configuration unavailable";
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.admin"],
          methodResponses: {
            ...pluginResponses(),
            "config.get": { __mockError: { code: "UNAVAILABLE", message } },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/plugins/workboard?view=settings");
        const editor = page.locator("openclaw-plugin-settings-editor");
        const error = editor.getByRole("alert").filter({ hasText: message });
        await error.waitFor();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const skeleton = editor.locator(".settings-loading-skeleton");
        expect.soft(await skeleton.count(), "failed settled read is not still loading").toBe(0);
        const retry = error.getByRole("button", { name: "Retry", exact: true });
        expect(await retry.isEnabled()).toBe(true);
        expect(await editor.getByLabel("Workspace label", { exact: true }).count()).toBe(0);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, editor, [error, retry], {
            animations: "disabled",
            scrollTo: editor,
          });
          await writeFile(path.join(suite.artifactDir, "failed-settings.png"), frame.png);
        }
        const reads = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("config.get");
        await retry.click();
        await gateway.waitForRequest("config.get", { after: reads });
        expect(await skeleton.count()).toBe(1);
        await gateway.resolveDeferred("config.get", configMocks["config.get"]);
        await editor.getByLabel("Workspace label", { exact: true }).waitFor();
        expect(await skeleton.count()).toBe(0);
        expect(await error.count()).toBe(0);
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
      },
    );
  });
});
