import { afterEach, expect, it, vi } from "vitest";
import * as channelCatalog from "../channels/bundled-channel-catalog-read.js";
import * as pluginPolicy from "../plugins/config-state.js";
import { materializePluginAutoEnableCandidates } from "./plugin-auto-enable.js";
import { makeRegistry } from "./plugin-auto-enable.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

it("materializes declared non-channel plugins without acquiring channel catalogs", () => {
  const catalog = vi.spyOn(channelCatalog, "listBundledChannelCatalogEntries").mockReturnValue([]);
  const result = materializePluginAutoEnableCandidates({
    config: {
      plugins: { allow: ["existing"], entries: { companion: { enabled: true } } },
    },
    candidates: [
      { pluginId: "inference", kind: "provider-model-configured", modelRef: "inference/small" },
      { pluginId: "helper", kind: "setup-auto-enable", reason: "helper configured" },
    ],
    env: {},
    manifestRegistry: makeRegistry(
      ["inference", "helper", "companion"].map((id) => ({ id, channels: [], origin: "bundled" })),
    ),
  });
  expect(result.config.plugins).toEqual({
    allow: ["existing", "inference", "helper", "companion"],
    entries: {
      inference: { enabled: true },
      helper: { enabled: true },
      companion: { enabled: true },
    },
  });
  expect(result.config.channels).toBeUndefined();
  expect(catalog.mock.calls.length).toBe(0);
});

it("prepares unchanged plugin policy once across candidate preference checks", () => {
  const normalize = vi.spyOn(pluginPolicy, "normalizePluginsConfig");
  const ids = ["first", "second", "third", "fourth", "fifth"];
  const config = {
    plugins: { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) },
  };
  const before = structuredClone(config);
  const result = materializePluginAutoEnableCandidates({
    config,
    candidates: ids.map((pluginId) => ({
      pluginId,
      kind: "setup-auto-enable" as const,
      reason: "plugin configured",
    })),
    env: {},
    manifestRegistry: makeRegistry(ids.map((id) => ({ id, channels: [], origin: "bundled" }))),
  });
  expect(result).toEqual({ config: before, changes: [], autoEnabledReasons: {} });
  expect(result.config).toBe(config);
  expect(config).toEqual(before);
  expect(normalize).toHaveBeenCalledTimes(1);
});

it("keeps a non-channel plugin independent of a same-named disabled channel", () => {
  const result = materializePluginAutoEnableCandidates({
    config: { channels: { telegram: { enabled: false } } },
    candidates: [{ pluginId: "telegram", kind: "setup-auto-enable", reason: "plugin configured" }],
    env: {},
    manifestRegistry: makeRegistry([{ id: "telegram", channels: [], origin: "bundled" }]),
  });
  expect(result.config.plugins?.entries?.telegram?.enabled).toBe(true);
  expect(result.config.channels?.telegram?.enabled).toBe(false);
});

it("retains runtime catalog aliases when no manifest owner is available", () => {
  vi.spyOn(channelCatalog, "listBundledChannelCatalogEntries").mockReturnValue([
    {
      id: "runtime-channel",
      aliases: ["runtime-alias"],
      channel: { id: "runtime-channel" },
      order: 0,
    },
  ]);
  const result = materializePluginAutoEnableCandidates({
    config: {},
    candidates: [
      { pluginId: "runtime-channel", kind: "channel-configured", channelId: "runtime-alias" },
    ],
    env: {},
    manifestRegistry: makeRegistry([]),
  });
  expect(result.config.channels?.["runtime-channel"]).toEqual({ enabled: true });
  expect(result.config.plugins).toBeUndefined();
});

it("reads mixed-case plugin policy under the canonical lowercase key", () => {
  const ids = ["MyProv", "OtherProv", "OnProv"];
  const config = {
    plugins: {
      deny: ["otherprov"],
      entries: { myprov: { enabled: false }, onprov: { enabled: true } },
    },
  };
  const result = materializePluginAutoEnableCandidates({
    config,
    candidates: ids.map((pluginId) => ({
      pluginId,
      kind: "provider-auth-configured" as const,
      providerId: pluginId.toLowerCase(),
    })),
    env: {},
    manifestRegistry: makeRegistry(ids.map((id) => ({ id, channels: [], origin: "global" }))),
  });
  expect(result.config).toEqual(config);
  expect(result.changes).toEqual([]);
});

it.each([{ config: { apiKey: "fixture-key" } }, { hooks: { timeoutMs: 1_000 } }])(
  "preserves original plugin settings during preference and allowlist rewrites: %j",
  (entry) => {
    const config = { plugins: { allow: ["existing"], entries: { legacy: entry } } };
    const before = structuredClone(config);
    const result = materializePluginAutoEnableCandidates({
      config,
      candidates: ["preferred", "legacy"].map((pluginId) => ({
        pluginId,
        kind: "setup-auto-enable" as const,
        reason: "plugin configured",
      })),
      env: {},
      manifestRegistry: makeRegistry([
        { id: "legacy", channels: [], origin: "global" },
        {
          id: "preferred",
          channels: [],
          origin: "global",
          channelConfigs: { preferred: { schema: {}, preferOver: ["legacy"] } },
        },
      ]),
    });
    expect(result.config.plugins).toEqual({
      allow: ["existing", "preferred", "legacy"],
      entries: { legacy: entry, preferred: { enabled: true } },
    });
    expect(config).toEqual(before);
  },
);
