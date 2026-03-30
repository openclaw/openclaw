import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
  vi.doUnmock("../../config/io.js");
  vi.resetModules();
});

function mockDiscoveryWithChannels(channelIds: string[]) {
  const candidates = channelIds.map((id) => ({
    rootDir: `/fake/extensions/${id}`,
    source: `/fake/extensions/${id}/index.ts`,
    origin: "bundled",
  }));
  const plugins = channelIds.map((id) => ({
    id,
    rootDir: `/fake/extensions/${id}`,
    origin: "bundled",
    channels: [{ id }],
    setupSource: null,
  }));

  vi.doMock("../../plugins/discovery.js", () => ({
    discoverOpenClawPlugins: () => ({
      candidates,
      diagnostics: [],
    }),
  }));
  vi.doMock("../../plugins/manifest-registry.js", () => ({
    loadPluginManifestRegistry: () => ({
      plugins,
      diagnostics: [],
    }),
  }));
  // Mock the boundary file check and jiti loader so loadBundledModule
  // returns a fake channel plugin entry without hitting the filesystem.
  vi.doMock("../../infra/boundary-file-read.js", () => ({
    openBoundaryFileSync: ({ absolutePath }: { absolutePath: string }) => ({
      ok: true,
      path: absolutePath,
      fd: 999,
    }),
  }));
  vi.doMock("jiti", () => ({
    createJiti: () => (modulePath: string) => {
      const id = modulePath.split("/").at(-2) ?? "unknown";
      return { default: { channelPlugin: { id } } };
    },
  }));
  vi.doMock("../../plugins/sdk-alias.js", () => ({
    buildPluginLoaderAliasMap: () => ({}),
    buildPluginLoaderJitiOptions: () => ({}),
    shouldPreferNativeJiti: () => false,
  }));
  // Stub fs.closeSync since we return a fake fd.
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return { ...actual, default: { ...actual, closeSync: () => {} } };
  });
}

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

describe("bundled channel plugins.allow filtering", () => {
  it("skips channels not in plugins.allow", async () => {
    vi.resetModules();
    mockDiscoveryWithChannels(["discord", "slack", "imessage", "telegram"]);
    vi.doMock("../../config/io.js", () => ({
      loadConfig: () => ({
        plugins: { allow: ["discord", "slack"] },
      }),
    }));

    const bundled = await import("./bundled.js");
    const plugins = bundled.listBundledChannelPlugins();
    const ids = plugins.map((p) => p.id);

    expect(ids).toContain("discord");
    expect(ids).toContain("slack");
    expect(ids).not.toContain("imessage");
    expect(ids).not.toContain("telegram");
  });

  it("loads all channels when plugins.allow is not set", async () => {
    vi.resetModules();
    mockDiscoveryWithChannels(["discord", "slack", "imessage"]);
    vi.doMock("../../config/io.js", () => ({
      loadConfig: () => ({}),
    }));

    const bundled = await import("./bundled.js");
    const plugins = bundled.listBundledChannelPlugins();
    const ids = plugins.map((p) => p.id);

    expect(ids).toContain("discord");
    expect(ids).toContain("slack");
    expect(ids).toContain("imessage");
  });

  it("loads all channels when loadConfig throws", async () => {
    vi.resetModules();
    mockDiscoveryWithChannels(["discord", "slack", "imessage"]);
    vi.doMock("../../config/io.js", () => ({
      loadConfig: () => {
        throw new Error("config not ready");
      },
    }));

    const bundled = await import("./bundled.js");
    const plugins = bundled.listBundledChannelPlugins();
    const ids = plugins.map((p) => p.id);

    expect(ids).toContain("discord");
    expect(ids).toContain("slack");
    expect(ids).toContain("imessage");
  });
});
