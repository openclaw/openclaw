import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import { findContextEnginePluginIdSelector } from "./context-engine-plugin-id-selector.js";

function plugin(
  id: string,
  contextEngineIds?: string[],
  kind: PluginManifestRecord["kind"] = "context-engine",
): PluginManifestRecord {
  return {
    id,
    kind,
    ...(contextEngineIds ? { contextEngineIds } : {}),
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "global",
    rootDir: `/plugins/${id}`,
    source: `/plugins/${id}`,
    manifestPath: `/plugins/${id}/openclaw.plugin.json`,
  };
}

function config(contextEngine: string, plugins: OpenClawConfig["plugins"] = {}): OpenClawConfig {
  return {
    plugins: {
      entries: { "vendor-plugin": { enabled: true } },
      ...plugins,
      slots: { contextEngine },
    },
  };
}

describe("findContextEnginePluginIdSelector", () => {
  it("replaces a released installer's plugin-ID selector with the single declared engine", () => {
    expect(
      findContextEnginePluginIdSelector(config("Vendor-Plugin"), [
        plugin("vendor-plugin", ["MiXeD-Engine"]),
      ]),
    ).toEqual({
      kind: "replace",
      selector: "Vendor-Plugin",
      pluginId: "vendor-plugin",
      engineId: "MiXeD-Engine",
    });
  });

  it("accepts an owner approved only through the allowlist", () => {
    expect(
      findContextEnginePluginIdSelector(
        config("vendor-plugin", { allow: ["vendor-plugin"], entries: {} }),
        [plugin("vendor-plugin", ["MiXeD-Engine"])],
      ),
    ).toMatchObject({ kind: "replace", engineId: "MiXeD-Engine" });
  });

  it.each([
    ["an explicit engine", config("MiXeD-Engine"), [plugin("vendor-plugin", ["MiXeD-Engine"])]],
    [
      "a plugin ID that is also a declared engine",
      config("vendor-plugin"),
      [plugin("vendor-plugin", ["other"]), plugin("other-owner", ["vendor-plugin"])],
    ],
    ["an undeclared equal-ID plugin", config("vendor-plugin"), [plugin("vendor-plugin")]],
    [
      "a non-engine plugin declaration",
      config("vendor-plugin"),
      [plugin("vendor-plugin", ["MiXeD-Engine"], "memory")],
    ],
    ["legacy", config("legacy"), [plugin("legacy", ["MiXeD-Engine"])]],
    ["none", config("none"), [plugin("none", ["MiXeD-Engine"])]],
    [
      "disabled plugins",
      config("vendor-plugin", { enabled: false }),
      [plugin("vendor-plugin", ["MiXeD-Engine"])],
    ],
  ] satisfies Array<[string, OpenClawConfig, PluginManifestRecord[]]>)(
    "leaves %s unchanged",
    (_name, cfg, plugins) => {
      expect(findContextEnginePluginIdSelector(cfg, plugins)).toBeUndefined();
    },
  );

  it.each([
    [
      "multiple declared engines",
      config("vendor-plugin"),
      [plugin("vendor-plugin", ["engine-a", "engine-b"])],
      "set plugins.slots.contextEngine to one of: engine-a, engine-b",
    ],
    [
      "an owner that is not independently enabled",
      config("vendor-plugin", { entries: {} }),
      [plugin("vendor-plugin", ["MiXeD-Engine"])],
      'Enable plugins.entries.vendor-plugin or resolve the conflict, then set plugins.slots.contextEngine to "MiXeD-Engine"',
    ],
    [
      "a case-equal engine outside a restrictive allowlist",
      config("vendor-plugin", { allow: ["other"], entries: {} }),
      [plugin("vendor-plugin", ["Vendor-Plugin"])],
      "is not independently enabled",
    ],
    [
      "an enabled owner outside a restrictive allowlist",
      config("vendor-plugin", { allow: ["other"] }),
      [plugin("vendor-plugin", ["MiXeD-Engine"])],
      "is not independently enabled",
    ],
    [
      "a denied owner",
      config("vendor-plugin", { deny: ["vendor-plugin"] }),
      [plugin("vendor-plugin", ["MiXeD-Engine"])],
      "is not independently enabled",
    ],
    [
      "another eligible owner of the same engine",
      config("vendor-plugin", {
        entries: { "vendor-plugin": { enabled: true }, rival: { enabled: true } },
      }),
      [plugin("vendor-plugin", ["MiXeD-Engine"]), plugin("rival", ["MiXeD-Engine"])],
      "another eligible plugin declares the same engine",
    ],
  ] satisfies Array<[string, OpenClawConfig, PluginManifestRecord[], string]>)(
    "keeps the selector and asks for a choice with %s",
    (_name, cfg, plugins, message) => {
      const finding = findContextEnginePluginIdSelector(cfg, plugins);
      expect(finding?.kind).toBe("choose");
      expect(finding && "message" in finding ? finding.message : "").toContain(message);
    },
  );
});
