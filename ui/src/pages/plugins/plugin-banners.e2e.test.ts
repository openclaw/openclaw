import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  calendarDiscoveryPlugin,
  calendarInspection,
  calendarPlugin,
  describeControlUiE2e,
  installMockGateway,
  inventory,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

describeControlUiE2e("Plugin pages without generic trust banners", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it.each(["code-plugin", "bundle-plugin", "native-ui", "discovery"] as const)(
    "keeps %s content and actions without a generic banner",
    async (scenario) => {
      const context = await newContext({ width: 1440, height: 1000 });
      onTestFinished(() => context.close());
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: "light" });
      const detail = {
        plugin: {
          ...calendarDiscoveryPlugin,
          catalog: {
            ...calendarDiscoveryPlugin.catalog,
            family: scenario === "bundle-plugin" ? "bundle-plugin" : "code-plugin",
          },
        },
        detail: {
          origin: "clawhub",
          packageName: "calendar-plus",
          topics: [],
          configuration: [],
          mcpServers: [],
          skills: [],
          versions: [],
        },
      };
      await installMockGateway(page, {
        featureMethods: pluginMethods,
        methodResponses: {
          ...pluginMethodResponses(),
          "plugins.catalog.get": detail,
          "plugins.list": inventory(
            scenario === "native-ui" ? [{ ...calendarPlugin, hasNativeUi: true }] : [],
          ),
          "plugins.inspect": {
            ...calendarInspection,
            plugin: calendarPlugin,
            overview: { hasNativeUi: true },
          },
        },
      });
      await page.goto(
        server.baseUrl +
          (scenario === "native-ui"
            ? "settings/plugins/calendar-plus"
            : scenario === "discovery"
              ? "plugins"
              : "plugins/" + detail.plugin.id),
      );
      const content = page.locator(
        scenario === "discovery" ? ".plugin-catalog-results" : ".plugin-catalog-detail",
      );
      const action =
        scenario === "discovery"
          ? page.getByRole("searchbox", { name: "Search plugins", exact: true })
          : page.getByRole("button", {
              name: scenario === "native-ui" ? "Disable Calendar Plus" : "Install",
              exact: true,
            });
      await action.waitFor();
      expect(await action.isEnabled()).toBe(true);
      if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
        const directory = createControlUiE2eArtifactDir("plugin-banners");
        const frame = await takeControlUiScreenshotFrame(page, content, [action], {
          animations: "disabled",
        });
        writeFileSync(path.join(directory, scenario + ".png"), frame.png);
      }
      expect(await content.locator(".plugin-native-ui-disclosure").count()).toBe(0);
      expect(await content.textContent()).not.toMatch(
        /Plugin code|Bundle contents|Includes native web UI|Only (?:install|enable) (?:plugins|bundles) you trust/,
      );
    },
  );
});
