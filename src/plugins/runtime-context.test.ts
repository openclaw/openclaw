import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resolvePluginRuntimeRecord } from "./runtime-context.js";
import { withPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-fixtures.js";

describe("plugin runtime record source ownership", () => {
  it("resolves unrelated modules after a captured instance is disposed", async () => {
    const registry = createEmptyPluginRegistry();
    const retired = createPluginRecord({ id: "retired", rootDir: path.resolve("retired") });
    const current = createPluginRecord({ id: "current", rootDir: path.resolve("current") });
    registry.plugins.push(retired, current);
    const instance = new PluginInstance(retired.id, { record: retired, registry });
    instance.bindModuleLoader(
      () => ({}),
      (source) => source === retired.source,
    );
    await instance.dispose();
    withPluginCache(createPluginCache(), () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: registry, isWebchatConnect: () => false },
        () => {
          expect(resolvePluginRuntimeRecord({ modulePath: path.resolve("current/api.js") })).toBe(
            current,
          );
          expect(
            resolvePluginRuntimeRecord({ modulePath: path.resolve("unknown/api.js") }),
          ).toBeUndefined();
          expect(() => instance.loadModule(retired.source)).toThrow(/reloaded or disabled/);
        },
      ),
    );
  });

  it.each([
    ["plugin", "plugin/api.js", true],
    ["plugin", "plugin", true],
    ["plugin/", "plugin/api.js", true],
    ["plugin/.", "plugin/api.js", true],
    ["plugin/../owner", "owner/api.js", true],
    ["plugin", "plugin/subdir/../api.js", true],
    ["plugin", "plugin-sibling/api.js", false],
    ["plugin", "plugin/../owner/api.js", false],
    ["plugin", "owner/api.js", false],
  ] as const)("matches root %s against source %s (%s)", (root, source, matches) => {
    const base = path.resolve("runtime-owner-fixture");
    const record = createPluginRecord({ id: "owner", rootDir: `${base}${path.sep}${root}` });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(record);
    withPluginCache(createPluginCache(), () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: registry, isWebchatConnect: () => false },
        () => {
          const params = { modulePath: `${base}${path.sep}${source}` };
          expect(resolvePluginRuntimeRecord(params)).toBe(matches ? record : undefined);
          expect(resolvePluginRuntimeRecord(params)).toBe(matches ? record : undefined);
        },
      ),
    );
  });

  it("keeps filesystem roots and changed record paths live across registry scopes", () => {
    const modulePath = path.resolve("runtime-owner-fixture/plugin/api.js");
    const record = createPluginRecord({ id: "owner", rootDir: path.parse(modulePath).root });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(record);
    const otherRegistry = createEmptyPluginRegistry();
    const otherRecord = createPluginRecord({ id: "other", rootDir: path.dirname(modulePath) });
    otherRegistry.plugins.push(otherRecord);
    withPluginCache(createPluginCache(), () =>
      withPluginRuntimeGatewayRequestScope(
        { pluginRegistry: registry, isWebchatConnect: () => false },
        () => {
          expect(resolvePluginRuntimeRecord({ modulePath })).toBe(record);
          record.rootDir = path.resolve("runtime-owner-fixture/unrelated");
          expect(resolvePluginRuntimeRecord({ modulePath })).toBeUndefined();
          withPluginRuntimeGatewayRequestScope(
            { pluginRegistry: otherRegistry, isWebchatConnect: () => false },
            () => expect(resolvePluginRuntimeRecord({ modulePath })).toBe(otherRecord),
          );
          expect(resolvePluginRuntimeRecord({ modulePath })).toBeUndefined();
          record.rootDir = path.dirname(modulePath);
          expect(resolvePluginRuntimeRecord({ modulePath })).toBe(record);
        },
      ),
    );
  });
});
