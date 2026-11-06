import type { Page } from "playwright";
import { controlUiPluginAssetRoot } from "../../../src/gateway/control-ui-plugin-assets-contract.js";
import type {
  ControlUiMockGatewayInstallOptions,
  MockGatewayControls,
} from "./control-ui-e2e-contract.ts";
import { defaultControlUiFeatureMethods } from "./control-ui-e2e-defaults.ts";
import { installMockGateway } from "./control-ui-e2e.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-mock-scenario.ts";
import {
  prepareNativeControlUiPluginFixtures,
  type NativeControlUiPluginFixture,
} from "./control-ui-plugin-fixture.ts";

export type NativeControlUiMockGatewayScenario = ControlUiMockGatewayScenario & {
  nativePlugins?: readonly NativeControlUiPluginFixture[];
};

// Keep native build dependencies with their consumers, outside the shared browser harness.
export async function installNativePluginMockGateway(
  page: Page,
  { nativePlugins, ...scenario }: NativeControlUiMockGatewayScenario = {},
  options: ControlUiMockGatewayInstallOptions = {},
): Promise<MockGatewayControls> {
  if (!nativePlugins?.length) {
    return installMockGateway(page, scenario, options);
  }
  const { catalog, assets } = await prepareNativeControlUiPluginFixtures(nativePlugins);
  if (assets.size) {
    await page.route(`**${controlUiPluginAssetRoot()}**`, async (route) => {
      const asset = assets.get(new URL(route.request().url()).pathname);
      await route.fulfill(asset ? { status: 200, ...asset } : { status: 404 });
    });
  }
  const preparedScenario = catalog.plugins.length
    ? {
        ...scenario,
        featureMethods: [
          ...new Set([
            ...(scenario.featureMethods ?? defaultControlUiFeatureMethods),
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ]),
        ],
        methodResponses: {
          ...scenario.methodResponses,
          "plugins.controlUi.list": catalog,
          "plugins.controlUi.report": { ok: true },
        },
      }
    : scenario;
  return installMockGateway(page, preparedScenario, options);
}
