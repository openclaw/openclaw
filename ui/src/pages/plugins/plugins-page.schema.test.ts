/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { configMocks } from "../../e2e/plugins-settings-admin.test-support.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

const hello = gatewayHelloForMethods(["config.get", "config.schema", "plugins.list"]);
const capabilities = new Set<ReturnType<typeof createRuntimeConfigCapability>>();

async function mountAdvanced(options: { connected: boolean; schema?: () => Promise<unknown> }) {
  const inventory = createResult();
  const { client, request } = createClient(async (method) => {
    switch (method) {
      case "config.get":
        return configMocks["config.get"];
      case "config.schema":
        return options.schema ? options.schema() : configMocks["config.schema"];
      case "plugins.list":
        return inventory;
      default:
        throw new Error(`Unexpected method: ${method}`);
    }
  });
  const gateway = createGateway(client, options.connected);
  gateway.emit(client, options.connected, { hello });
  const runtimeConfig = createRuntimeConfigCapability(gateway.gateway);
  capabilities.add(runtimeConfig);
  const schemaLoads = vi.spyOn(runtimeConfig, "ensureSchemaLoaded");
  const { page } = await mountPage(
    { ...createContext(gateway.gateway), runtimeConfig },
    createPluginsRouteData(
      gateway.gateway,
      options.connected ? inventory : null,
      createPluginsRouteLocation("/settings/plugins?tab=advanced"),
    ),
  );
  return {
    page,
    request,
    runtimeConfig,
    connect: () => gateway.emit(client, true, { hello }),
    async settle() {
      await runtimeConfig.ensureLoaded();
      await Promise.all(schemaLoads.mock.results.map((result) => result.value));
      await page.updateComplete;
    },
  };
}

function expectAdvancedFields(page: HTMLElement) {
  const advanced = page.querySelector("#plugin-settings-advanced");
  expect(advanced?.textContent).toContain("Plugin system enabled");
  expect(advanced?.textContent).toContain("Allowed plugin IDs");
  expect(advanced?.textContent).toContain("Blocked plugin IDs");
  expect(advanced?.textContent).not.toContain("Plugin settings schema is unavailable");
}

describe("PluginsPage Advanced schema loading", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    resetPluginsPageTestState();
    for (const capability of capabilities) {
      capability.dispose();
    }
    capabilities.clear();
  });

  it("renders global plugin settings when the Gateway connects after the page mounts", async () => {
    const harness = await mountAdvanced({ connected: false });
    await harness.settle();
    expect(harness.request).not.toHaveBeenCalledWith("config.schema", {});

    harness.connect();
    await harness.settle();

    expectAdvancedFields(harness.page);
    expect(
      harness.request.mock.calls.filter(([method]) => method === "config.schema"),
    ).toHaveLength(1);
  });

  it("reloads the missing schema after a failed schema read", async () => {
    const firstSchema = createDeferred<(typeof configMocks)["config.schema"]>();
    let attempts = 0;
    const harness = await mountAdvanced({
      connected: true,
      schema: () =>
        ++attempts === 1 ? firstSchema.promise : Promise.resolve(configMocks["config.schema"]),
    });
    await harness.runtimeConfig.ensureLoaded();
    firstSchema.reject(new Error("Schema temporarily unavailable"));
    await harness.settle();
    expect(harness.page.querySelector('[role="alert"]')?.textContent).toContain(
      "Schema temporarily unavailable",
    );

    const reload = harness.page.querySelector<HTMLButtonElement>('[aria-label="Reload"]');
    expect(reload).not.toBeNull();
    const reloads = vi.spyOn(harness.runtimeConfig, "discardDraft");
    reload?.click();
    await Promise.all(reloads.mock.results.map((result) => result.value));
    await harness.settle();

    expectAdvancedFields(harness.page);
    expect(attempts).toBe(2);
    expect(harness.request.mock.calls.some(([method]) => method === "config.set")).toBe(false);
  });
});
