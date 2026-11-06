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

export async function prepareNativePluginMockGatewayScenario({
  nativePlugins,
  ...scenario
}: NativeControlUiMockGatewayScenario = {}) {
  if (!nativePlugins?.length) {
    return { scenario, assets: new Map<string, { body: Buffer; contentType: string }>() };
  }
  const { catalog, assets } = await prepareNativeControlUiPluginFixtures(nativePlugins);
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
  return { scenario: preparedScenario, assets };
}

// Keep native build dependencies with their consumers, outside the shared browser harness.
export async function installNativePluginMockGateway(
  page: Page,
  scenario: NativeControlUiMockGatewayScenario = {},
  options: ControlUiMockGatewayInstallOptions = {},
): Promise<MockGatewayControls> {
  const prepared = await prepareNativePluginMockGatewayScenario(scenario);
  if (prepared.assets.size) {
    await page.route(`**${controlUiPluginAssetRoot()}**`, async (route) => {
      const asset = prepared.assets.get(new URL(route.request().url()).pathname);
      await route.fulfill(asset ? { status: 200, ...asset } : { status: 404 });
    });
  }
  return installMockGateway(page, prepared.scenario, options);
}
