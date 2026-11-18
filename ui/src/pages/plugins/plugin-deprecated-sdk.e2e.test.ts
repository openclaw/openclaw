import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
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

const displayedNotice =
  "Uses older OpenClaw APIs. Migration date: Oct 1, 2026. Check for a plugin update.";

const notice = {
  code: "deprecated-sdk-api",
  severity: "info",
  message: "SDK compatibility notice from the Gateway.",
  removalDate: "2026-10-01",
  migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate",
  apis: [
    {
      id: "cron-store-path:resolveCronStorePath",
      displayName: "resolveCronStorePath",
      replacement: "resolveCronStorePathAsync",
      removeAfter: "2026-10-01",
    },
  ],
} as const;

describeControlUiE2e("Plugin SDK compatibility notice", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("shows a dated migration notice in inventory without changing plugin state", async () => {
    const context = await newContext();
    onTestFinished(() => context.close());
    const page = await context.newPage();
    const plugin = {
      ...calendarPlugin,
      id: "sdk-demo",
      name: "SDK Demo",
      compatibilityNotices: [{ ...notice, apis: [...notice.apis] }],
    };
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": inventory([plugin]),
        "plugins.inspect": { ...calendarInspection, plugin },
      },
    });
    const artifactDir =
      process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1"
        ? createControlUiE2eArtifactDir("plugin-deprecated-sdk")
        : undefined;
    const capture = async (name: string, surface: Locator, elements: Locator[] = []) => {
      if (!artifactDir) {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(page, surface, [surface], {
        animations: "disabled",
        elements,
      });
      await writeFile(path.join(artifactDir, name), frame.png);
    };
    await page.goto(`${server.baseUrl}settings/plugins`);
    const row = page.locator('[data-plugin-id="sdk-demo"]');
    await row.getByText("SDK Demo", { exact: true }).waitFor();
    expect(await row.locator('[data-plugin-state="enabled"]').count()).toBe(1);
    const message = row.locator(".plugins-row-message--info");
    expect(await message.textContent()).toContain(displayedNotice);
    expect(await message.getAttribute("role")).toBe("status");
    expect(await message.locator("svg, .warn, [role=alert]").count()).toBe(0);
    expect(await message.getByRole("link", { name: "Details" }).getAttribute("href")).toBe(
      notice.migrationGuideUrl,
    );
    expect(await row.locator(".plugin-compatibility-apis").count()).toBe(0);
    expect(await row.textContent()).not.toContain(notice.apis[0].displayName);
    await capture("plugins-inventory.png", row, [row]);
    await row.getByRole("link", { name: /SDK Demo/ }).click();
    await page.getByRole("heading", { name: "SDK Demo", exact: true }).waitFor();
    await gateway.waitForRequest("plugins.inspect");
    expect(await page.locator(".plugin-compatibility-apis").count()).toBe(0);
    expect(await page.locator(".plugin-catalog-detail").textContent()).not.toContain(
      displayedNotice,
    );
    await capture("plugin-detail.png", page.locator(".plugin-catalog-detail"));
    expect(await page.getByRole("button", { name: "Disable SDK Demo", exact: true }).count()).toBe(
      1,
    );
    expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
  });
});
