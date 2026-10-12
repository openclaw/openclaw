// Plugin update selection tests cover CLI plugin update target selection.
import { describe, expect, it } from "vitest";
import type { HookInstallRecord } from "../config/types.hooks.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  resolveHookPackUpdateSelection,
  resolvePluginUpdateSelection,
} from "./plugins-update-selection.js";

function createNpmInstall(params: {
  spec: string;
  installPath?: string;
  resolvedName?: string;
}): PluginInstallRecord {
  return {
    source: "npm",
    spec: params.spec,
    installPath: params.installPath ?? "/tmp/plugin",
    ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
  };
}

function createNpmHookInstall(params: {
  spec: string;
  installPath?: string;
  resolvedName?: string;
}): HookInstallRecord {
  return {
    source: "npm",
    spec: params.spec,
    installPath: params.installPath ?? "/tmp/hook-pack",
    ...(params.resolvedName ? { resolvedName: params.resolvedName } : {}),
  };
}

describe("resolvePluginUpdateSelection", () => {
  it("deduplicates packed children and retains an explicit selector in input order", () => {
    expect(
      resolvePluginUpdateSelection({
        installs: {
          pack: createNpmInstall({ spec: "@acme/pack@stable" }),
          other: createNpmInstall({ spec: "@acme/other" }),
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
          pack: createNpmInstall({ spec: "@acme/pack", resolvedName: "@acme/pack" }),
        },
        rawIds: ["pack/two"],
      }),
    ).toEqual({ pluginIds: [], unmatchedIds: ["pack/two"] });
  });

  it("rejects an ambiguous package owner for targeted and update-all selection", () => {
    const installs = {
      pack: createNpmInstall({ spec: "@acme/pack" }),
      stable: createNpmInstall({ spec: "@acme/stable" }),
    };
    const rejectedPluginIds = new Map([["pack", "ambiguous pack"]]);

    expect(resolvePluginUpdateSelection({ installs, rejectedPluginIds, rawIds: ["pack"] })).toEqual(
      {
        pluginIds: [],
        error: "ambiguous pack",
      },
    );
    expect(
      resolvePluginUpdateSelection({ installs, rejectedPluginIds, rawIds: [], all: true }),
    ).toEqual({
      pluginIds: [],
      error: "ambiguous pack",
    });
  });
});

describe("resolveHookPackUpdateSelection", () => {
  it.each([{ packageName: "openclaw-demo-hooks", requestedSpec: "openclaw-demo-hooks" }])(
    "maps npm package spec $requestedSpec to its tracked hook pack",
    ({ packageName, requestedSpec }) => {
      expect(
        resolveHookPackUpdateSelection({
          installs: {
            "demo-hooks": createNpmHookInstall({
              spec: `${packageName}@1.0.0`,
              resolvedName: packageName,
            }),
          },
          rawIds: [requestedSpec],
        }),
      ).toEqual({
        hookIds: ["demo-hooks"],
        specOverrides: { "demo-hooks": requestedSpec },
      });
    },
  );
});
