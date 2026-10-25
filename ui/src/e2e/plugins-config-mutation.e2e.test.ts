// Control UI tests cover plugin mutations serialized behind pending config drafts.
import { expect, it } from "vitest";
import type { PluginsInspectResult } from "../lib/plugins/index.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { inspection } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI plugin config mutation mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function configResponse(fallback: string | undefined, workboardEnabled: boolean, hash: string) {
  const defaultModel = { primary: "openai/gpt-5" };
  const model = { ...defaultModel, ...(fallback ? { fallbacks: [fallback] } : {}) };
  const config = {
    agents: {
      defaults: { model: defaultModel },
      entries: { main: { model } },
    },
    plugins: { entries: { workboard: { enabled: workboardEnabled } } },
  };
  return { ...configSnapshot(config, hash), appliedConfigHash: hash };
}

const workboardDisabled = {
  id: "workboard",
  name: "Workboard",
  origin: "global",
  installed: true,
  enabled: false,
  state: "disabled",
};

const workboardEnabled = {
  ...workboardDisabled,
  enabled: true,
  state: "enabled",
};

function workboardInspection(enabled: boolean): PluginsInspectResult {
  return {
    ok: true,
    reviewToken: "a".repeat(64),
    plugin: {
      id: workboardDisabled.id,
      name: workboardDisabled.name,
      origin: workboardDisabled.origin,
      installed: true,
      enabled,
    },
    declared: { ...inspection.declared, tools: [] },
    components: {
      ...inspection.components,
      mapped: [],
      skills: [],
      mcpServers: [],
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: true },
        allowConversationAccess: { effective: false },
      },
    },
  };
}

suite.define(() => {
  it("config.set drains a pending draft before re-enabling an accepted external plugin without review", () =>
    suite.withPage(createDarkDesktopControlUiContextOptions(), async ({ page }) => {
      const pluginList = (enabled: boolean) => ({
        plugins: [enabled ? workboardEnabled : workboardDisabled],
        diagnostics: [],
        mutationAllowed: true,
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: [{ id: "main", identity: { name: "Main" }, name: "Main" }],
          },
          "config.get": configResponse(undefined, false, "config-hash-1"),
          "plugins.inspect": workboardInspection(false),
          "plugins.list": pluginList(false),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/agents/main/overview`);
      expect(response?.status()).toBe(200);

      const fallbackInput = page.locator("openclaw-multi-select.agent-fallbacks input");
      await fallbackInput.waitFor();
      await gateway.deferNext("config.set");
      await fallbackInput.fill("anthropic/claude-sonnet-4-6");
      await fallbackInput.press("Enter");
      await page.evaluate(() => {
        history.pushState(null, "", "/settings/plugins");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await waitForControlUiRoute(page, {
        pathname: "/settings/plugins",
        routeId: "plugin-settings",
      });

      const workboardRow = page.locator('[data-plugin-id="workboard"]');
      await workboardRow.waitFor();
      const connects = (await gateway.getRequests("connect")).length;

      await workboardRow.click();
      await waitForControlUiRoute(page, {
        pathname: "/settings/plugins/workboard",
        routeId: "plugin-settings",
      });

      await gateway.deferNext("plugins.setEnabled");
      await page.getByRole("button", { name: "Enable Workboard", exact: true }).click();
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);

      const pendingDraft = await gateway.waitForRequest("config.set");
      expect(pendingDraft.params).toMatchObject({ baseHash: "config-hash-1" });
      await gateway.resolveDeferred("config.set");

      const enableRequest = await gateway.waitForRequest("plugins.setEnabled");
      expect(enableRequest.params).toEqual({ pluginId: "workboard", enabled: true });
      await gateway.setMethodResponse(
        "config.get",
        configResponse("anthropic/claude-sonnet-4-6", true, "config-hash-3"),
      );
      await gateway.setMethodResponse("plugins.list", pluginList(true));
      await gateway.setMethodResponse("plugins.inspect", workboardInspection(true));
      await gateway.resolveDeferred("plugins.setEnabled", {
        ok: true,
        plugin: workboardEnabled,
        restartRequired: false,
        runtime: { operationId: "enable-workboard", generation: 1, pluginIds: ["workboard"] },
      });

      await page.getByRole("button", { name: "Disable Workboard", exact: true }).waitFor();
      expect((await gateway.getRequests("plugins.inspect")).length).toBeGreaterThan(0);
      expect(await page.locator("[data-plugin-consent]").count()).toBe(0);
      await expect
        .poll(async () => (await gateway.getRequests("config.get")).length)
        .toBeGreaterThanOrEqual(2);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
    }));
});
