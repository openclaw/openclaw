import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

afterEach(() => {
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
});

describe("bundled channel entry shape guards", () => {
  it("treats missing bundled discovery results as empty", async () => {
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

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=missing-bundled-discovery",
    );

    expect(bundled.listBundledChannelPlugins()).toEqual([]);
    expect(bundled.listBundledChannelSetupPlugins()).toEqual([]);
  });
});
