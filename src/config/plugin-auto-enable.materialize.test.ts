import { afterEach, expect, it, vi } from "vitest";
import * as channelCatalog from "../channels/bundled-channel-catalog-read.js";
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

it.each([
  { entries: { google: { enabled: false } } },
  { deny: [" GOOGLE-GEMINI-CLI "] },
  { allow: ["GOOGLE"], entries: { google: { enabled: true } } },
])("respects canonical alias policy without rewriting authored entries: %j", (plugins) => {
  const config = { plugins };
  const result = materializePluginAutoEnableCandidates({
    config,
    candidates: [
      { pluginId: "GoOgLe-GeMiNi-ClI", kind: "setup-auto-enable", reason: "configured" },
    ],
    env: {},
    manifestRegistry: makeRegistry([{ id: "GoOgLe-GeMiNi-ClI", channels: [] }]),
  });
  expect(result.config).toBe(config);
  expect(result.changes).toEqual([]);
});

it("adds canonical enablement without losing raw collision payloads or duplicating allow aliases", () => {
  const canonical = {
    config: { choice: "canonical" },
    apiKey: "synthetic-canonical",
    env: { A: "one" },
  };
  const alternate = {
    config: { choice: "alternate" },
    apiKey: "synthetic-alternate",
    env: { B: "two" },
  };
  const config = {
    plugins: { allow: ["MYPROV"], entries: { myprov: canonical, MyProv: alternate } },
  };
  const result = materializePluginAutoEnableCandidates({
    config,
    candidates: [{ pluginId: "MyProv", kind: "setup-auto-enable", reason: "configured" }],
    env: {},
    manifestRegistry: makeRegistry([{ id: "MyProv", channels: [] }]),
  });
  expect(result.config.plugins).toEqual({
    allow: ["MYPROV"],
    entries: { myprov: { ...canonical, enabled: true }, MyProv: alternate },
  });
  expect(config.plugins.entries).toEqual({ myprov: canonical, MyProv: alternate });
  expect(result.autoEnabledReasons).toEqual({ MyProv: ["configured"] });
});

it.each(["config", "apiKey", "env"] as const)(
  "keeps explicit alternate-case %s selection when another channel is preferred",
  (field) => {
    const payload = { config: { choice: "keep" }, apiKey: "synthetic", env: { A: "one" } };
    const original = { [field]: payload[field] };
    const result = materializePluginAutoEnableCandidates({
      config: { plugins: { entries: { MYPROV: original } } },
      candidates: [
        { pluginId: "MyProv", kind: "channel-configured", channelId: "old-channel" },
        { pluginId: "preferred", kind: "channel-configured", channelId: "new-channel" },
      ],
      env: {},
      manifestRegistry: makeRegistry([
        { id: "MyProv", channels: ["old-channel"] },
        {
          id: "preferred",
          channels: ["new-channel"],
          channelConfigs: {
            "new-channel": { schema: { type: "object" }, preferOver: ["MyProv"] },
          },
        },
      ]),
    });
    expect(result.config.plugins?.entries).toEqual({
      MYPROV: original,
      preferred: { enabled: true },
    });
  },
);
