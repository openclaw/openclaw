import { describe, expect, it, vi } from "vitest";
import { applyPluginAutoEnable } from "./plugin-auto-enable.js";
import { makeIsolatedEnv, resetPluginAutoEnableTestState } from "./plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { afterEach } from "vitest";

vi.mock("../channels/plugins/configured-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/plugins/configured-state.js")>();
  return {
    ...actual,
    hasBundledChannelConfiguredState: () => false,
    isRuntimeChannelConnected: () => false,
  };
});

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>();
  return {
    ...actual,
  };
});

afterEach(() => {
  resetPluginAutoEnableTestState();
});

describe("applyPluginAutoEnable caching", () => {
  it("returns the same result for the same config and env references", () => {
    const config: OpenClawConfig = {};
    const env = makeIsolatedEnv();
    const result1 = applyPluginAutoEnable({ config, env });
    const result2 = applyPluginAutoEnable({ config, env });
    expect(result1).toBe(result2);
  });

  it("recomputes when config reference changes", () => {
    const env = makeIsolatedEnv();
    const config1: OpenClawConfig = {};
    const config2: OpenClawConfig = {};
    const result1 = applyPluginAutoEnable({ config: config1, env });
    const result2 = applyPluginAutoEnable({ config: config2, env });
    expect(result1).not.toBe(result2);
    expect(result1).toEqual(result2);
  });

  it("works without config or env (no cache, no crash)", () => {
    const result1 = applyPluginAutoEnable({});
    const result2 = applyPluginAutoEnable({});
    expect(result1).toEqual(result2);
    // Without config/env, no caching — different object references
    expect(result1).not.toBe(result2);
  });
});
