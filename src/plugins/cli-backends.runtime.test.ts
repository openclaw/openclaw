import { afterEach, describe, expect, it } from "vitest";
import {
  listCliRuntimeModelBackendBindings,
  resolveCliBackendConfig,
  resolveCliRuntimeCanonicalProvider,
} from "../agents/cli-backends.js";
import { isCliProvider } from "../agents/model-selection-cli.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { createPluginRuntime } from "./runtime/index.js";
import { createPluginRecord } from "./status.test-helpers.js";

describe("runtime CLI backend consumers", () => {
  const owners: NonNullable<ReturnType<typeof getPluginInstance>>[] = [];

  afterEach(async () => {
    for (const owner of owners) {
      await owner.dispose();
    }
    owners.length = 0;
    resetPluginRuntimeStateForTest();
  });

  function registerBackend(provider: string) {
    const builder = createRuntimeTestRegistry(createPluginRuntime());
    const record = createPluginRecord({ id: provider });
    const api = builder.createApi(record, { config: {} });
    api.registerCliBackend({
      id: "fixture-cli",
      modelProvider: provider,
      config: { command: `${provider}-cli` },
      resolveModelId: ({ modelId }) => `${provider}:${modelId}`,
      subscriptionAuthDispatch: true,
    });
    const owner = getPluginInstance(record);
    if (!owner) {
      throw new Error("Expected the registered CLI backend to have an instance");
    }
    owners.push(owner);
    return { builder, owner };
  }

  it("refreshes display metadata while retained execution hooks stay with their owner", async () => {
    const first = registerBackend("first-provider");
    setActivePluginRegistry(first.builder.registry);

    expect(isCliProvider(" FIXTURE-CLI ")).toBe(true);
    expect(resolveCliRuntimeCanonicalProvider({ runtime: "fixture-cli" })).toBe("first-provider");
    expect(listCliRuntimeModelBackendBindings()).toEqual([
      { provider: "first-provider", runtime: "fixture-cli", pluginId: "first-provider" },
    ]);
    const retained = resolveCliBackendConfig("fixture-cli");
    expect(retained?.config.command).toBe("first-provider-cli");
    expect(retained?.resolveModelId?.({ modelId: "demo" })).toBe("first-provider:demo");

    const second = registerBackend("second-provider");
    setActivePluginRegistry(second.builder.registry);
    await first.owner.dispose();

    expect(resolveCliRuntimeCanonicalProvider({ runtime: "fixture-cli" })).toBe("second-provider");
    expect(listCliRuntimeModelBackendBindings()).toEqual([
      { provider: "second-provider", runtime: "fixture-cli", pluginId: "second-provider" },
    ]);
    expect(resolveCliBackendConfig("fixture-cli")?.config.command).toBe("second-provider-cli");
    expect(() => retained?.resolveModelId?.({ modelId: "demo" })).toThrow(
      /reloaded|disabled|retir/i,
    );
  });
});
