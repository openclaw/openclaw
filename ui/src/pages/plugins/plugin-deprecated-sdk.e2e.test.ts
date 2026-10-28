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

const notice = {
  code: "deprecated-sdk-api",
  severity: "info",
  message:
    "Uses OpenClaw APIs that retire on Dec 31, 2026. It keeps working until then; check for a plugin update.",
  removalDate: "2026-12-31",
  migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration/how-to-migrate",
  apis: [
    {
      id: "cron-store-path:resolveCronStorePath",
      displayName: "resolveCronStorePath",
      replacement: "resolveCronStorePathAsync",
      removeAfter: "2026-12-31",
    },
  ],
} as const;

describeControlUiE2e("Plugin SDK compatibility notice", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("shows a calm retirement notice and details without changing plugin state", async () => {
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
    expect(await message.textContent()).toContain(notice.message);
    expect(await message.getAttribute("role")).toBe("status");
    expect(
      await message.locator("svg, .oc-banner-warning, .oc-banner-error, [role=alert]").count(),
    ).toBe(0);
    expect(await message.getByRole("link", { name: "Details" }).getAttribute("href")).toBe(
      notice.migrationGuideUrl,
    );
    expect(await row.locator(".plugin-compatibility-apis").count()).toBe(0);
    expect(await row.textContent()).not.toContain(notice.apis[0].displayName);
    await capture("plugins-inventory.png", row, [row]);
    await row.getByRole("link", { name: /SDK Demo/ }).click();
    await page.getByRole("heading", { name: "SDK Demo", exact: true }).waitFor();
    await gateway.waitForRequest("plugins.inspect");
    const apis = page.locator(".plugin-compatibility-apis");
    await apis.waitFor();
    expect(await apis.locator("dt").allTextContents()).toEqual([notice.apis[0].displayName]);
    expect(await apis.locator("dd").allTextContents()).toEqual([notice.apis[0].replacement]);
    await capture("plugin-detail.png", page.locator(".plugin-catalog-detail"));
    expect(await page.getByRole("button", { name: "Disable SDK Demo", exact: true }).count()).toBe(
      1,
    );
    expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
  });
});
