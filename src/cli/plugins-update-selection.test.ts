import { describe, expect, it } from "vitest";
import {
  resolveHookPackUpdateSelection,
  resolvePluginUpdateSelection,
} from "./plugins-update-selection.js";

function createNpmInstall(spec: string, resolvedName?: string) {
  return {
    source: "npm" as const,
    spec,
    installPath: "/tmp/plugin",
    ...(resolvedName ? { resolvedName } : {}),
  };
}

describe("resolvePluginUpdateSelection", () => {
  it("deduplicates packed children and retains an explicit selector in input order", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          pack: createNpmInstall("@acme/pack@stable"),
          other: createNpmInstall("@acme/other"),
        },
        installOwnerByPluginId: new Map([
          ["pack/one", "pack"],
          ["pack/two", "pack"],
        ]),
        rawIds: ["pack/one", "other", "@acme/pack@beta", "pack/two", "@acme/pack@beta"],
      }),
    ).toEqual({ pluginIds: ["pack", "other"], specOverrides: { pack: "@acme/pack@beta" } });
  });

  it("does not infer a packed child owner when owner metadata is missing", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          pack: createNpmInstall("@acme/pack", "@acme/pack"),
        },
        rawIds: ["pack/two"],
      }),
    ).toEqual({ pluginIds: [], unmatchedIds: ["pack/two"] });
  });

  it.each([false, true])("rejects an ambiguous package owner (all: %s)", (all) => {
    const installs = {
      pack: createNpmInstall("@acme/pack"),
      stable: createNpmInstall("@acme/stable"),
    };
    const rejectedPluginIds = new Map([["pack", "ambiguous pack"]]);
    expect(
      resolvePluginUpdateSelection({
        installs,
        rejectedPluginIds,
        all,
        rawIds: all ? [] : ["pack"],
      }),
    ).toEqual({ pluginIds: [], error: "ambiguous pack" });
  });

  it.each([false, true])("skips operator-managed ids (all: %s)", (all) => {
    const installs = {
      local: createNpmInstall("@acme/local"),
      stable: createNpmInstall("@acme/stable"),
    };
    const skippedPluginIds = new Set(["local"]);

    expect(
      resolvePluginUpdateSelection({
        installs,
        skippedPluginIds,
        all,
        rawIds: all ? [] : ["@acme/local", "stable"],
      }),
    ).toEqual({ pluginIds: ["stable"], skippedIds: ["local"] });
  });
  it("maps an npm package spec to its tracked hook pack", () => {
    expect(
      resolveHookPackUpdateSelection({
        installs: {
          "demo-hooks": createNpmInstall("openclaw-demo-hooks@1.0.0", "openclaw-demo-hooks"),
        },
        rawIds: ["openclaw-demo-hooks"],
      }),
    ).toEqual({
      hookIds: ["demo-hooks"],
      specOverrides: { "demo-hooks": "openclaw-demo-hooks" },
    });
  });
});
