import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import manifest from "../../../../extensions/huggingface/openclaw.plugin.json" with { type: "json" };
import {
  calendarInspection,
  calendarPlugin,
  captureScreenshot,
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

const object = (properties: Record<string, unknown>) => ({ type: "object", properties });

describeControlUiE2e("Hugging Face settings", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("offers separate opt-in Hub tools and saves the plugin-owned setting", async () => {
    const plugin = {
      ...calendarPlugin,
      id: "huggingface",
      name: "Hugging Face",
      description: manifest.description,
      origin: "bundled" as const,
      removable: false,
      catalogId: "local_aHVnZ2luZ2ZhY2U",
    };
    const config = { plugins: { entries: { huggingface: { enabled: true, config: {} } } } };
    const context = await newContext();
    onTestFinished(() => context.close());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...pluginMethods, "config.get", "config.schema", "config.set"],
      operatorScopes: ["operator.read", "operator.admin"],
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": inventory([plugin]),
        "plugins.inspect": {
          ...calendarInspection,
          plugin,
          declared: { ...calendarInspection.declared, tools: [] },
        },
        "plugins.catalog.get": { __mockError: { code: "UNAVAILABLE", message: "Catalog offline" } },
        "config.get": {
          config,
          raw: JSON.stringify(config),
          hash: "hf-config",
          appliedConfigHash: "hf-config",
          valid: true,
          issues: [],
        },
        "config.schema": {
          schema: object({
            plugins: object({
              entries: object({ huggingface: object({ config: manifest.configSchema }) }),
            }),
          }),
          uiHints: Object.fromEntries(
            Object.entries(manifest.uiHints).map(([key, value]) => [
              "plugins.entries.huggingface.config." + key,
              value,
            ]),
          ),
          version: "hf-schema",
          generatedAt: "2026-11-11T00:00:00Z",
        },
      },
    });
    await page.goto(server.baseUrl + "plugins/" + plugin.catalogId + "?view=settings");
    await page.getByRole("searchbox", { name: "Search settings", exact: true }).waitFor();
    await page.locator('[data-setting="discovery.enabled"]').getByRole("checkbox").waitFor();
    await captureScreenshot(page, "huggingface-settings.png", "viewport");
    const hub = page.locator('[data-setting="hub.enabled"]').getByRole("checkbox");
    expect(await hub.count()).toBe(1);
    expect(await hub.isChecked()).toBe(false);
    await hub.press("Space");
    await expect.poll(() => hub.isChecked()).toBe(true);
    await expect.poll(async () => (await gateway.getRequests("config.set")).length).toBe(1);
    const writes = await gateway.getRequests("config.set");
    const saved = JSON.parse((writes[0]!.params as { raw: string }).raw);
    expect(saved.plugins.entries.huggingface.config.hub.enabled).toBe(true);
    expect(saved.plugins.entries.huggingface.enabled).toBe(true);
    await expect.poll(() => hub.isEnabled()).toBe(true);
    await page.reload();
    await hub.waitFor();
    expect(await hub.isChecked()).toBe(true);
    expect(
      await page.locator('[data-setting="discovery.enabled"]').getByRole("checkbox").isChecked(),
    ).toBe(false);
  });
});
