import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { PluginDiscoveryEntry } from "../../../packages/gateway-protocol/src/schema/plugins.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Appearance catalog integration" });
const pack: PluginDiscoveryEntry = {
  id: "reef-lobsters",
  catalog: {
    name: "Reef Lobsters",
    summary: "Original reef characters and sprite animations for the LobsterDex.",
    author: "studio",
    family: "code-plugin",
    official: false,
    categories: ["lobster-packs"],
    latestVersion: "1.0.0",
  },
  local: {
    present: false,
    installed: false,
    enabled: false,
    state: "not-installed",
    action: "install",
  },
};

suite.define(() => {
  it("discovers packs on demand, retains category during search, retries, and links to existing management without collecting", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1200 },
        colorScheme: "dark",
        locale: "en-US",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ id: "appearance-demo", name: "Appearance demo", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
          methodResponses: {
            "config.get": configResponse({ themeMode: "dark" }, "appearance-integration"),
            "users.prefs.get": { status: "ok", entries: {} },
            "themes.browse": { items: [], nextCursor: null },
            "plugins.catalog.browse": { items: [pack] },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/appearance");
        await waitForControlUiSettingsTakeover(page);
        expect(await gateway.getRequests("themes.browse")).toEqual([]);
        expect(await gateway.getRequests("plugins.catalog.browse")).toEqual([]);
        const inventory = () =>
          page.evaluate(() =>
            Object.fromEntries(
              Object.entries(localStorage).filter(([key]) =>
                key.toLowerCase().includes("lobsterdex"),
              ),
            ),
          );
        const initialInventory = await inventory();
        const requestIndex = await gateway.deferNext("plugins.catalog.browse");
        await page.getByRole("tab", { name: "Lobster Packs", exact: true }).click();
        await gateway.waitForRequest("plugins.catalog.browse", { after: requestIndex });
        const panel = page.locator("#appearance-packs-panel");
        await expect.poll(() => panel.getByRole("status").allTextContents()).toContain("Loading…");
        await gateway.rejectDeferred("plugins.catalog.browse", { message: "Registry unavailable" });
        await expect
          .poll(() => panel.getByRole("alert").textContent())
          .toContain("Registry unavailable");
        await panel.getByRole("button", { name: "Retry", exact: true }).click();
        await panel.getByText("Reef Lobsters", { exact: true }).waitFor();
        expect(
          await panel.getByRole("link", { name: "Review pack", exact: true }).getAttribute("href"),
        ).toBe("/plugins/reef-lobsters");
        expect(
          await panel
            .getByRole("link", { name: "Manage installed plugins", exact: true })
            .getAttribute("href"),
        ).toBe("/settings/plugins");
        expect(await inventory()).toEqual(initialInventory);
        expect(await gateway.getRequests("plugins.install")).toEqual([]);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".config-content"),
          [panel.getByText("Reef Lobsters", { exact: true })],
          { animations: "disabled", scrollTo: page.locator(".settings-theme-grid") },
        );
        await writeFile(path.join(suite.artifactDir, "appearance-packs-after.png"), frame.png);
        await panel.getByRole("searchbox", { name: "Search Lobster Packs" }).fill("reef");
        await expect
          .poll(async () => (await gateway.getRequests("plugins.catalog.browse")).at(-1)?.params)
          .toMatchObject({ category: "lobster-packs", query: "reef" });
        for (const request of await gateway.getRequests("plugins.catalog.browse")) {
          expect(request.params).toMatchObject({ category: "lobster-packs" });
        }
        await gateway.setMethodResponse("plugins.catalog.browse", {
          items: [
            {
              ...pack,
              local: {
                ...pack.local,
                installed: true,
                enabled: true,
                state: "enabled",
                pluginId: "reef-lobsters",
                action: "manage",
              },
            },
          ],
        });
        await gateway.emitGatewayEvent("plugins.changed", { generation: 1 });
        await panel.getByRole("link", { name: "Manage pack", exact: true }).waitFor();
        expect(
          await panel.getByRole("link", { name: "Manage pack", exact: true }).getAttribute("href"),
        ).toBe("/settings/plugins/reef-lobsters");
        await gateway.setMethodResponse("plugins.catalog.browse", { items: [] });
        await gateway.emitGatewayEvent("plugins.changed", { generation: 2 });
        await panel
          .getByText("No Lobster Packs found. Try another search or check back later.")
          .waitFor();
        await gateway.setMethodResponse("plugins.catalog.browse", { items: [pack] });
        await gateway.emitGatewayEvent("plugins.changed", { generation: 3 });
        await panel.getByText("Reef Lobsters", { exact: true }).waitFor();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        const mobile = await takeControlUiScreenshotFrame(
          page,
          page.locator(".config-content"),
          [panel.getByRole("searchbox")],
          { animations: "disabled", scrollTo: panel.getByRole("searchbox") },
        );
        await writeFile(path.join(suite.artifactDir, "appearance-packs-mobile.png"), mobile.png);
        await page.getByRole("tab", { name: "Themes", exact: true }).click();
        await page.getByRole("button", { name: "Browse and manage themes" }).click();
        await gateway.waitForRequest("themes.browse");
        expect(await inventory()).toEqual(initialInventory);
        await page.getByRole("tab", { name: "Lobster Packs", exact: true }).click();
        await panel.getByRole("link", { name: "View in LobsterDex" }).click();
        await page.locator("openclaw-lobsterdex-page").waitFor();
        expect(new URL(page.url()).pathname).toBe("/settings/lobsterdex");
      },
    );
  });
});
