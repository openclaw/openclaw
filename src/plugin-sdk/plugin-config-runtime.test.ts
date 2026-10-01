/**
 * Tests config runtime exports and snapshot/cache behavior exposed through the SDK.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { normalizePluginsConfig as readNormalizedPluginsConfig } from "../plugins/config-state.js";
import type { OpenClawConfig } from "./config-contracts.js";
import {
  resolveLivePluginConfigObject,
  resolvePluginConfigObject,
} from "./plugin-config-runtime.js";
import { normalizePluginsConfig } from "./plugin-config-runtime.js";

afterEach(() => clearRuntimeConfigSnapshot());

it("keeps public normalized policy mutable without changing the published host policy", () => {
  const pluginConfig = { mode: "strict" };
  const config: OpenClawConfig = {
    plugins: {
      allow: ["google"],
      entries: { "google-gemini-cli": { enabled: true, config: pluginConfig } },
    },
  };
  setRuntimeConfigSnapshot(config);
  const policy = normalizePluginsConfig(config.plugins);
  policy.allow.push("other");
  policy.entries.google!.enabled = false;

  expect(readNormalizedPluginsConfig(config.plugins).allow).toEqual(["google"]);
  expect(readNormalizedPluginsConfig(config.plugins).entries.google?.enabled).toBe(true);
  expect(normalizePluginsConfig(config.plugins).entries.google?.enabled).toBe(true);
  expect(resolvePluginConfigObject(config, "google")).toBe(pluginConfig);
  expect(Object.isFrozen(pluginConfig)).toBe(false);
});

describe("resolvePluginConfigObject", () => {
  it("returns the plugin config object for a configured plugin entry", () => {
    const config = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: {
              enabled: false,
              mode: "strict",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "demo-plugin")).toEqual({
      enabled: false,
      mode: "strict",
    });
  });

  it("reads config through normalized plugin entry ids", () => {
    const config = {
      plugins: {
        entries: {
          " CODEX ": {
            enabled: true,
            config: { supervision: { enabled: true } },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "codex")).toEqual({
      supervision: { enabled: true },
    });
  });

  it("returns undefined for missing or non-object plugin configs", () => {
    const config = {
      plugins: {
        entries: {
          "demo-plugin": {
            enabled: true,
            config: "bad-shape",
          },
          "array-plugin": {
            enabled: true,
            config: ["bad-shape"],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolvePluginConfigObject(config, "missing-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(config, "demo-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(config, "array-plugin")).toBeUndefined();
    expect(resolvePluginConfigObject(undefined, "demo-plugin")).toBeUndefined();
  });
});

describe("resolveLivePluginConfigObject", () => {
  it("falls back to startup config only when no runtime loader exists", () => {
    expect(
      resolveLivePluginConfigObject(undefined, "demo-plugin", {
        enabled: true,
      }),
    ).toEqual({
      enabled: true,
    });
  });

  it("fails closed when the runtime loader exists but the plugin entry is missing", () => {
    const config = {
      plugins: {
        entries: {},
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveLivePluginConfigObject(() => config, "demo-plugin", {
        enabled: true,
      }),
    ).toBeUndefined();
  });
});
