import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
  vi.resetModules();
});

describe("bundled channel entry shape guards", () => {
  it("treats missing bundled discovery results as empty", async () => {
    vi.resetModules();
    vi.doMock("../../plugins/discovery.js", () => ({
      discoverOpenClawPlugins: () => ({
        candidates: [],
        diagnostics: [],
      }),
    }));
    vi.doMock("../../plugins/manifest-registry.js", () => ({
      loadPluginManifestRegistry: () => ({
        plugins: [],
        diagnostics: [],
      }),
    }));

    const bundled = await import("./bundled.js");

    expect(bundled.listBundledChannelPlugins()).toEqual([]);
    expect(bundled.listBundledChannelSetupPlugins()).toEqual([]);
  });
});
