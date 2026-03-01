import { afterEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.hoisted(() => vi.fn());
const listCatalogMock = vi.hoisted(() => vi.fn());
const listPluginsMock = vi.hoisted(() => vi.fn());
const ensurePluginRegistryLoadedMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const base = ("default" in actual ? actual.default : actual) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...base,
      readFileSync: readFileSyncMock,
    },
    readFileSync: readFileSyncMock,
  };
});

vi.mock("../channels/registry.js", () => ({
  CHAT_CHANNEL_ORDER: ["telegram", "discord"],
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: listCatalogMock,
}));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: listPluginsMock,
}));

vi.mock("./plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

async function loadModule() {
  return await import("./channel-options.js");
}

describe("resolveCliChannelOptions", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_EAGER_CHANNEL_OPTIONS;
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("uses precomputed startup metadata when available", async () => {
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ channelOptions: ["cached", "telegram", "cached"] }),
    );
    listCatalogMock.mockReturnValue([{ id: "catalog-only" }]);

    const mod = await loadModule();
    expect(mod.resolveCliChannelOptions()).toEqual(["cached", "telegram", "catalog-only"]);
    expect(listCatalogMock).toHaveBeenCalledOnce();
  });

  it("falls back to dynamic catalog resolution when metadata is missing", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    listCatalogMock.mockReturnValue([{ id: "feishu" }, { id: "telegram" }]);

    const mod = await loadModule();
    expect(mod.resolveCliChannelOptions()).toEqual(["telegram", "discord", "feishu"]);
    expect(listCatalogMock).toHaveBeenCalledOnce();
  });

  it("respects eager mode and includes loaded plugin ids", async () => {
    process.env.OPENCLAW_EAGER_CHANNEL_OPTIONS = "1";
    readFileSyncMock.mockReturnValue(JSON.stringify({ channelOptions: ["cached"] }));
    listCatalogMock.mockReturnValue([{ id: "zalo" }]);
    listPluginsMock.mockReturnValue([{ id: "custom-a" }, { id: "custom-b" }]);

    const mod = await loadModule();
    expect(mod.resolveCliChannelOptions()).toEqual([
      "telegram",
      "discord",
      "zalo",
      "custom-a",
      "custom-b",
    ]);
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledOnce();
    expect(listPluginsMock).toHaveBeenCalledOnce();
  });

  it("keeps dynamic catalog resolution when external catalog env is set", async () => {
    process.env.OPENCLAW_PLUGIN_CATALOG_PATHS = "/tmp/plugins-catalog.json";
    readFileSyncMock.mockReturnValue(JSON.stringify({ channelOptions: ["cached", "telegram"] }));
    listCatalogMock.mockReturnValue([{ id: "custom-catalog" }]);

    const mod = await loadModule();
    expect(mod.resolveCliChannelOptions()).toEqual(["cached", "telegram", "custom-catalog"]);
    expect(listCatalogMock).toHaveBeenCalledOnce();
    delete process.env.OPENCLAW_PLUGIN_CATALOG_PATHS;
  });
});
