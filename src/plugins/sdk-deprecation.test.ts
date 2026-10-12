import { afterEach, expect, it, vi } from "vitest";
import { PluginInstance } from "./plugin-instance.js";
import { withPluginRuntimePluginScope } from "./runtime/gateway-request-scope.js";
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
      useLegacy("writer");
      useLegacy("writer");
      useLegacy("transcript");
    });
    reloaded.run(() => useLegacy("writer"));
    withPluginRuntimePluginScope({ pluginId: "sdk-warning-other" }, () => useLegacy("writer"));
    expect(warning).toHaveBeenCalledTimes(3);
    expect(warning.mock.calls.map(([message]) => String(message).split(":")[0])).toEqual([
      "Plugin sdk-warning-owner",
      "Plugin sdk-warning-owner",
      "Plugin sdk-warning-other",
    ]);
    for (const [message] of warning.mock.calls) {
      expect(message).toContain("store.writeAsync");
      expect(message).toContain("remains supported in the current Plugin SDK major");
      expect(message).toContain("removed in the next Plugin SDK major");
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
    "Plugin SDK: store.write is deprecated; use store.writeAsync instead. The legacy contract remains supported in the current Plugin SDK major. It will be removed in the next Plugin SDK major.",
    { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
  );
});
