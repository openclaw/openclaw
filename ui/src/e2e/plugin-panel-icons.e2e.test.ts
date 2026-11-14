import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "plugin panel icons" });
const sessionKey = "agent:main:panel-icons";
const svg = await fs.readFile(
  new URL("../../../extensions/knowledge/assets/panel-icon.svg", import.meta.url),
  "utf8",
);
const icon = "data:image/svg+xml," + encodeURIComponent(svg);
const moduleSource = `export default {id:"panel-fixture",activate(host) {
  host.ui.registerPanel({id:"activity",label:"Knowledge",mount(container) {
    const p = document.createElement("p"); p.textContent = "Knowledge activity for this conversation"; container.append(p);
  }});
}};`;
const catalog = (revision: string, panelIcon?: string) => ({
  revision,
  diagnostics: [],
  plugins: [
    {
      pluginId: "panel-fixture",
      name: "Panel fixture",
      revision,
      entryUrl: `/__openclaw__/plugins/control-ui/panel-fixture/` + revision + "/index.js",
      styles: [],
      ...(panelIcon ? { panelIcon } : {}),
    },
  ],
});

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "uses %s SVG artwork in launchers and tabs, and recovers malformed artwork",
    async (mode) => {
      await suite.withPage(
        { colorScheme: mode, viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            sessionKey,
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "plugins.controlUi.list",
              "plugins.controlUi.report",
            ],
            methodResponses: {
              "config.get": themeConfigResponse("claw", mode),
              "plugins.controlUi.list": catalog("before"),
              "plugins.controlUi.report": { ok: true },
            },
          });
          await page.route("**/__openclaw__/plugins/control-ui/panel-fixture/*/index.js", (route) =>
            route.fulfill({ status: 200, contentType: "text/javascript", body: moduleSource }),
          );
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
          await gateway.waitForRequest("plugins.controlUi.report");
          await openChatSidePanelType(page, "Files");
          const header = page.locator('[data-region-header="side"]');
          const launcher = page.locator(".side-panel-launcher");
          const option = launcher.getByRole("button", { name: "Knowledge", exact: true });
          const openLauncher = () =>
            header.getByRole("button", { name: "New tab", exact: true }).click();
          const capture = async (name: string) => {
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
              return;
            }
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("openclaw-app"),
              [launcher],
              { animations: "disabled" },
            );
            await fs.writeFile(path.join(suite.artifactDir, name + "-" + mode + ".png"), frame.png);
          };
          await openLauncher();
          await option.locator("svg").waitFor();
          await option.click();
          const tab = header.getByRole("tab", { name: "Knowledge", exact: true });
          await tab.locator("svg").waitFor();
          await openLauncher();
          await capture("before-tabs-and-launcher");
          await gateway.setMethodResponse("plugins.controlUi.list", catalog("after", icon));
          await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "after" });
          await option.locator("i.session-css-icon").waitFor();
          expect(await option.locator("svg").count()).toBe(0);
          await capture("after-tabs-and-launcher");
          const glyph = tab.locator("i.session-css-icon");
          expect(await glyph.evaluate((node) => getComputedStyle(node).maskImage)).toContain(
            "data:image/svg+xml",
          );
          expect(await page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
          expect(
            await glyph.evaluate(
              (node) => getComputedStyle(node).backgroundColor === getComputedStyle(node).color,
            ),
          ).toBe(true);
          expect(
            await page.locator('[data-panel-slot="plugin:panel-fixture/activity"]').textContent(),
          ).toContain("Knowledge activity");
          await gateway.setMethodResponse(
            "plugins.controlUi.list",
            catalog("invalid", "data:image/svg+xml,%3Csvg%3E"),
          );
          await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "invalid" });
          await option.locator("svg").waitFor();
          expect(await option.locator("i.session-css-icon").count()).toBe(0);
          await tab.locator("svg").waitFor();
        },
      );
    },
  );
});
