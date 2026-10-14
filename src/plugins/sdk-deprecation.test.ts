import { afterEach, expect, it, vi } from "vitest";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginRuntimePluginScope } from "./runtime/gateway-request-scope.js";
import { getPluginSdkDeprecationUsage } from "./sdk-deprecation-usage.js";
import { warnPluginSdkDeprecation } from "./sdk-deprecation.js";

afterEach(() => vi.restoreAllMocks());

it("attributes legacy use to its runtime owner and gives each family an independent budget", async () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const first = new PluginInstance("sdk-warning-owner");
  const reloaded = new PluginInstance("sdk-warning-owner");
  const useLegacy = (family: string) =>
    warnPluginSdkDeprecation({ family, method: "store.write", replacement: "store.writeAsync" });
  try {
    await first.run(async () => {
      await Promise.resolve();
      useLegacy("session-store");
      useLegacy("session-store");
      useLegacy("session-transcript");
    });
    reloaded.run(() => useLegacy("session-store"));
    withPluginRuntimePluginScope({ pluginId: "sdk-warning-other" }, () =>
      useLegacy("session-store"),
    );
    reloaded.run(() =>
      warnPluginSdkDeprecation({
        family: "session-store",
        method: "store.read",
        replacement: "store.readAsync",
      }),
    );
    expect(warning).toHaveBeenCalledTimes(3);
    expect(getPluginSdkDeprecationUsage("sdk-warning-owner").map((api) => api.id)).toEqual([
      "session-store:store.write",
      "session-transcript:store.write",
      "session-store:store.read",
    ]);
    expect(getPluginSdkDeprecationUsage("sdk-warning-other")).toEqual([
      {
        id: "session-store:store.write",
        displayName: "store.write",
        replacement: "store.writeAsync",
        removeAfter: "2026-12-31",
      },
    ]);
    expect(warning.mock.calls.map(([message]) => String(message).split(":")[0])).toEqual([
      "Plugin sdk-warning-owner",
      "Plugin sdk-warning-owner",
      "Plugin sdk-warning-other",
    ]);
    for (const [message] of warning.mock.calls) {
      expect(message).toContain("store.writeAsync");
      expect(message).toContain("remains supported during its deprecation period");
      expect(message).toContain("Final compatibility day: 2026-12-31");
      expect(message).toContain("first January 2027 stable release");
    }
  } finally {
    await Promise.all([first.dispose(), reloaded.dispose()]);
  }
});

it("bounds unscoped warnings and never prints path-like caller labels", () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  for (const pluginId of [
    undefined,
    "/private/synthetic-plugin",
    "synthetic\ncredential",
    undefined,
  ]) {
    warnPluginSdkDeprecation({
      family: "unknown-writer",
      method: "store.write",
      replacement: "store.writeAsync",
      pluginId,
    });
  }
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    "Plugin SDK: store.write is deprecated; use store.writeAsync instead. The legacy contract remains supported during its deprecation period. Removal requires an announced ordinary stable release window.",
    { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
  );
  expect(getPluginSdkDeprecationUsage("/private/synthetic-plugin")).toEqual([]);
});
