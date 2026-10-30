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
