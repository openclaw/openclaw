/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import type { PluginInstallRequest } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createContext,
  createDiscoveryDetail,
  createGateway,
  createInspectResult,
  createPlugin,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

beforeEach(() => i18n.setLocale("en"));
afterEach(resetPluginsPageTestState);

it.each([
  { enabled: false, warning: false },
  { enabled: true, warning: false },
  { enabled: true, warning: true },
])(
  "updates a pinned ClawHub plugin with enabled=$enabled and policy warning=$warning",
  async ({ enabled, warning }) => {
    const plugin = createPlugin({
      origin: "global",
      packageName: "@openclaw/workboard",
      clawhubPackage: "@openclaw/workboard",
      catalogId: "catalog:workboard",
      version: "1.0.0",
      enabled,
    });
    const catalog = createDiscoveryDetail(plugin);
    catalog.plugin.catalog.packageName = plugin.packageName;
    catalog.plugin.catalog.latestVersion = "1.0.1";
    const inspection = createInspectResult({
      source: {
        kind: "clawhub",
        packageName: plugin.packageName,
        spec: "clawhub:@openclaw/workboard@1.0.0",
      },
      catalog,
    });
    const { client, request } = createClient(async (method, params) => {
      if (method === "plugins.inspect") {
        return inspection;
      }
      if (method === "plugins.catalog.get") {
        return catalog;
      }
      if (method === "plugins.list") {
        return createResult(plugin);
      }
      if (method === "plugins.install") {
        if (warning && !(params as PluginInstallRequest).acknowledgeInstallPolicyWarning) {
          throw new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Review the updated package.",
            details: {
              installPolicyCode: "install_policy_warning_acknowledgement_required",
              targetName: plugin.id,
              targetType: "plugin",
              requestMode: "update",
              reason: "Review the updated package.",
            },
          });
        }
        return { ok: true, plugin: { ...plugin, version: "1.0.1" }, restartRequired: false };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway } = createGateway(client);
    const { page } = await mountPage(
      createContext(gateway),
      createPluginsRouteData(
        gateway,
        createResult(plugin),
        createPluginsRouteLocation("/settings/plugins/workboard"),
      ),
      "settings",
    );
    await waitForFast(() =>
      expect(page.querySelector('[aria-label="Update to 1.0.1 Workboard"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>('[aria-label="Update to 1.0.1 Workboard"]')!.click();
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith(
        "plugins.install",
        {
          source: "clawhub",
          packageName: "@openclaw/workboard",
          version: "1.0.1",
          expectedPluginId: "workboard",
          mode: "update",
          enable: false,
        },
        expect.anything(),
      ),
    );
    if (warning) {
      await waitForFast(() =>
        expect(page.querySelector(".plugins-row-message button")).not.toBeNull(),
      );
      expect(request.mock.calls.filter(([method]) => method === "plugins.install")).toHaveLength(1);
      page.querySelector<HTMLButtonElement>(".plugins-row-message button")!.click();
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith(
          "plugins.install",
          {
            source: "clawhub",
            packageName: "@openclaw/workboard",
            version: "1.0.1",
            expectedPluginId: "workboard",
            mode: "update",
            enable: false,
            acknowledgeInstallPolicyWarning: true,
          },
          expect.anything(),
        ),
      );
    }
    expect(
      request.mock.calls.some(
        ([method]) => method === "plugins.setEnabled" || method === "config.set",
      ),
    ).toBe(false);
  },
);
