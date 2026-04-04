import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginConfigUiHint } from "../plugins/types.js";
import { discoverConfigurablePlugins, discoverUnconfiguredPlugins } from "./setup.plugin-config.js";

function makeManifestPlugin(
  id: string,
  uiHints?: Record<string, PluginConfigUiHint>,
  configSchema?: Record<string, unknown>,
) {
  return {
    id,
    name: id,
    configUiHints: uiHints,
    configSchema,
    enabled: true,
    enabledByDefault: true,
  };
}

describe("discoverConfigurablePlugins", () => {
  it("returns plugins with non-advanced uiHints", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        mode: { label: "Mode", help: "Sandbox mode" },
        gateway: { label: "Gateway", help: "Gateway name" },
        gpu: { label: "GPU", advanced: true },
      }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(1);
    expect(result[0]).toBeDefined();
    expect(result[0].id).toBe("openshell");
    expect(Object.keys(result[0].uiHints)).toEqual(["mode", "gateway"]);
    // Advanced field excluded
    expect(result[0].uiHints.gpu).toBeUndefined();
  });

  it("excludes plugins with no uiHints", () => {
    const plugins = [makeManifestPlugin("bare-plugin")];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(0);
  });

  it("excludes plugins where all fields are advanced", () => {
    const plugins = [
      makeManifestPlugin("all-advanced", {
        gpu: { label: "GPU", advanced: true },
        timeout: { label: "Timeout", advanced: true },
      }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result).toHaveLength(0);
  });

  it("sorts results alphabetically by name", () => {
    const plugins = [
      makeManifestPlugin("zeta", { a: { label: "A" } }),
      makeManifestPlugin("alpha", { b: { label: "B" } }),
    ];
    const result = discoverConfigurablePlugins({ manifestPlugins: plugins });
    expect(result.map((p) => p.id)).toEqual(["alpha", "zeta"]);
  });
});

describe("discoverUnconfiguredPlugins", () => {
  it("returns plugins with at least one unconfigured field", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        mode: { label: "Mode" },
        gateway: { label: "Gateway" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          openshell: {
            config: { mode: "mirror" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config,
    });
    // gateway is unconfigured
    expect(result).toHaveLength(1);
    expect(result[0]).toBeDefined();
    expect(result[0].id).toBe("openshell");
  });

  it("excludes plugins where all fields are configured", () => {
    const plugins = [
      makeManifestPlugin("openshell", {
        mode: { label: "Mode" },
        gateway: { label: "Gateway" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          openshell: {
            config: { mode: "mirror", gateway: "my-gw" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config,
    });
    expect(result).toHaveLength(0);
  });

  it("treats empty string as unconfigured", () => {
    const plugins = [
      makeManifestPlugin("test-plugin", {
        endpoint: { label: "Endpoint" },
      }),
    ];
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          "test-plugin": {
            config: { endpoint: "" },
          },
        },
      },
    };
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config,
    });
    expect(result).toHaveLength(1);
  });

  it("returns empty when no plugins have uiHints", () => {
    const plugins = [makeManifestPlugin("bare")];
    const result = discoverUnconfiguredPlugins({
      manifestPlugins: plugins,
      config: {},
    });
    expect(result).toHaveLength(0);
  });
});
