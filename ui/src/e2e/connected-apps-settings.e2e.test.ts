import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  createControlUiMockSameOriginGatewayScript,
  defaultControlUiFeatureMethods,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Connected apps in Settings",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});
const caller = {
  principal: { kind: "owner" },
  principalLabel: "Gateway owner",
  ceiling: ["operator.read", "operator.write", "operator.admin"],
  canAdmin: true,
  canPair: true,
};

suite.define(() => {
  it("opens from Settings, keeps direct consent and pairing, and leaves Pages uncluttered", () =>
    suite.withPage(
      { viewport: { width: 1280, height: 900 }, locale: "en-US", colorScheme: "light" },
      async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
        const gateway = await installMockGateway(page, {
          controlUiTabs: [
            {
              pluginId: "mcp-relay",
              id: "connected-apps",
              slug: "connected-apps",
              label: "Connected apps",
              icon: "plug",
              group: "control",
              placement: "settings",
            },
          ],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "mcp-relay.grants",
            "mcp-relay.pair",
            "mcp-relay.authorize.describe",
          ],
          methodResponses: {
            "plugins.controlUi.list": {
              revision: "proof",
              diagnostics: [],
              plugins: [
                {
                  pluginId: "mcp-relay",
                  name: "MCP Relay",
                  revision: "proof",
                  entryUrl: "/__openclaw__/plugins/control-ui/mcp-relay/proof/index.js",
                  styles: [],
                },
              ],
            },
            "mcp-relay.grants": { grants: [], caller, relayUrl: "https://mcp.openclaw.ai" },
            "mcp-relay.pair": {
              code: "DEMO1-DEMO2",
              expiresAt: Date.now() + 600000,
              mcpUrl: "https://mcp.openclaw.ai/mcp",
            },
            "mcp-relay.authorize.describe": {
              kind: "oauth",
              clientName: "Example AI app",
              redirectHost: "example.com",
              expiresAt: Date.now() + 600000,
              caller,
            },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/mcp-relay/proof/index.js", (route) =>
          route.fulfill({
            contentType: "text/javascript",
            body:
              'export { default } from "/@fs/' +
              process.cwd() +
              '/extensions/mcp-relay/src/control-ui.ts";',
          }),
        );
        await page.goto(suite.server.baseUrl + "plugin?plugin=mcp-relay&id=connected-apps");
        const heading = page.getByRole("heading", { name: "Connected apps", exact: true });
        await heading.waitFor();
        await page.getByText("No connected apps yet", { exact: true }).waitFor();
        await page
          .locator(".settings-sidebar")
          .getByRole("link", { name: "Connected apps", exact: true })
          .waitFor();
        const connectedAppsLink = page
          .locator(".settings-sidebar")
          .getByRole("link", { name: "Connected apps", exact: true });
        const agentsGroup = page
          .locator(".settings-sidebar__group")
          .filter({ hasText: "Agents & tools" });
        expect(await agentsGroup.getByRole("link").last().textContent()).toBe("Connected apps");
        const shot = await takeControlUiScreenshotFrame(
          page,
          page.locator("openclaw-app"),
          [heading, page.getByText("No connected apps yet", { exact: true }), connectedAppsLink],
          { animations: "disabled", scrollTo: connectedAppsLink },
        );
        writeFileSync(path.join(suite.artifactDir, "after.png"), shot.png);
        await page.getByRole("button", { name: "Pair with code", exact: true }).click();
        await page.getByRole("button", { name: "Create pairing code", exact: true }).click();
        await page.getByText("DEMO1-DEMO2", { exact: true }).waitFor();
        await gateway.waitForRequest("mcp-relay.pair");
        await page.getByRole("button", { name: "Done", exact: true }).click();
        await page.getByRole("button", { name: "Back to app", exact: true }).click();
        await page
          .locator("openclaw-app-sidebar .sidebar-rail")
          .getByRole("button", { name: "Pages", exact: true })
          .click();
        expect(
          await page
            .locator(".sidebar-pages")
            .getByRole("link", { name: "Connected apps", exact: true })
            .count(),
        ).toBe(0);
        await page.goto(suite.server.baseUrl + "settings/appearance");
        const link = page
          .locator(".settings-sidebar")
          .getByRole("link", { name: "Connected apps", exact: true });
        const search = page.locator(".settings-sidebar__search-input");
        await search.fill("connected");
        await link.waitFor();
        await link.click();
        await heading.waitFor();
        expect(await search.inputValue()).toBe("connected");
        expect(await link.getAttribute("aria-current")).toBe("page");
        await search.focus();
        await page.keyboard.press("Escape");
        expect(await search.inputValue()).toBe("");
        await page.keyboard.press("Escape");
        await page.locator(".settings-sidebar").waitFor({ state: "hidden" });
        await page.goto(
          suite.server.baseUrl +
            "plugin?plugin=mcp-relay&id=connected-apps&p.request=example-request",
        );
        await page.getByText("Example AI app", { exact: false }).first().waitFor();
        expect((await gateway.getRequests("mcp-relay.authorize.describe")).at(-1)?.params).toEqual({
          requestId: "example-request",
        });
        await link.waitFor();
        const requestHeading = page.getByRole("heading", { name: "Connect Example AI app?" });
        expect((await heading.boundingBox())!.width).toBeGreaterThan(1);
        await page.setViewportSize({ width: 400, height: 820 });
        await page.locator(".topbar-page-title", { hasText: "Connected apps" }).waitFor();
        // The page heading remains available to assistive tech. The request is not a duplicate.
        await expect
          .poll(() => heading.evaluate((node) => getComputedStyle(node).clipPath))
          .toBe("inset(50%)");
        expect((await requestHeading.boundingBox())!.width).toBeGreaterThan(1);
        await page.locator(".topbar-nav-toggle").click();
        await link.waitFor();
        expect(await link.getAttribute("aria-current")).toBe("page");
        const mobile = await takeControlUiScreenshotFrame(
          page,
          page.locator("openclaw-app"),
          [link],
          { animations: "disabled", scrollTo: link },
        );
        writeFileSync(path.join(suite.artifactDir, "after-mobile-settings.png"), mobile.png);
        await link.click();
        await heading.waitFor();
        await expect.poll(() => page.locator(".shell--nav-drawer-open").count()).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(errors).toEqual([]);
      },
    ));
});
