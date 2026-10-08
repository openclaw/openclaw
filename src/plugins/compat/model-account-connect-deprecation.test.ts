import { expect, it, vi } from "vitest";
import { PluginInstance } from "../plugin-instance.js";
import { warnModelAccountConnectDeprecation } from "./model-account-connect-deprecation.js";

it("warns once per plugin and released account method, including after a plugin reload", async () => {
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const first = new PluginInstance("model-account-compat-first");
  const second = new PluginInstance("model-account-compat-second");
  const reloaded = new PluginInstance("model-account-compat-first");
  const methods = ["listLinks", "link", "unlink", "list", "select", "status", "cancel"] as const;
  try {
    first.run(() => {
      for (const method of methods) {
        warnModelAccountConnectDeprecation(method);
        warnModelAccountConnectDeprecation(method);
      }
    });
    second.run(() => {
      warnModelAccountConnectDeprecation("list");
      warnModelAccountConnectDeprecation("list");
    });
    reloaded.run(() => {
      for (const method of methods) {
        warnModelAccountConnectDeprecation(method);
      }
    });
    expect(warning).toHaveBeenCalledTimes(8);
    for (const { plugin, method } of [
      ...methods.map((name) => ({ plugin: "model-account-compat-first", method: name })),
      { plugin: "model-account-compat-second", method: "list" },
    ]) {
      const calls = warning.mock.calls.filter(
        ([message]) =>
          String(message).includes(plugin) &&
          String(message).includes(`modelAccountConnectService.${method} `),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toContain(`modelAccountConnectService.${method}Async`);
      expect(calls[0]?.[0]).toContain("next Plugin SDK major");
      expect(calls[0]?.[1]).toMatchObject({
        code: "DEP_SESSION_PERSISTENCE",
        type: "DeprecationWarning",
      });
    }
  } finally {
    warning.mockRestore();
    await Promise.all([first.dispose(), second.dispose(), reloaded.dispose()]);
  }
});
