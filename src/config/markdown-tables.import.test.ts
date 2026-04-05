import { beforeEach, describe, expect, it, vi } from "vitest";

const listBootstrapChannelPlugins = vi.hoisted(() =>
  vi.fn(() => [
    {
      id: "signal",
      messaging: {
        defaultMarkdownTableMode: "bullets",
      },
    },
  ]),
);

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  listBootstrapChannelPlugins,
}));

describe("markdown table defaults import behavior", () => {
  beforeEach(() => {
    vi.resetModules();
    listBootstrapChannelPlugins.mockClear();
  });

  it("does not bootstrap channel plugins during module import", async () => {
    const module = await import("./markdown-tables.js");

    expect(module.DEFAULT_TABLE_MODES).toBeDefined();
    expect(listBootstrapChannelPlugins).not.toHaveBeenCalled();
  });

  it("loads bootstrap defaults lazily on first access and memoizes them", async () => {
    const { DEFAULT_TABLE_MODES, resolveMarkdownTableMode } = await import("./markdown-tables.js");

    expect(DEFAULT_TABLE_MODES.get("signal")).toBe("bullets");
    expect(listBootstrapChannelPlugins).toHaveBeenCalledTimes(1);
    expect(resolveMarkdownTableMode({ channel: "signal" })).toBe("bullets");
    expect(listBootstrapChannelPlugins).toHaveBeenCalledTimes(1);
  });
});
