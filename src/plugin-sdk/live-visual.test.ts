import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveLiveVisualProvider, type LiveVisualProvider } from "./live-visual.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("live visual plugin SDK", () => {
  it("registers and resolves a provider from the active plugin generation", () => {
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "visual-owner",
      name: "Visual Owner",
      source: "/tmp/visual-owner/index.js",
      origin: "global",
      enabled: true,
      contracts: { liveVisualProviders: ["lobster"] },
      configSchema: false,
    });
    const provider: LiveVisualProvider = {
      id: "lobster",
      label: "Lobster",
      open: vi.fn(),
    };

    builder.createApi(record, { config: {} }).registerLiveVisualProvider(provider);
    setActivePluginRegistry(builder.registry);

    expect(resolveLiveVisualProvider({ providerId: "lobster", config: {} })).toBe(provider);
    expect(record.liveVisualProviderIds).toEqual(["lobster"]);
  });
});
