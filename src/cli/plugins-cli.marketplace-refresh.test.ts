// Covers the hosted OpenClaw marketplace feed refresh command.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const defaultRuntime = {
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn(),
  };
  return {
    defaultRuntime,
    getRuntimeConfig: vi.fn(),
    loadConfiguredHostedOfficialExternalPluginCatalogEntries: vi.fn(),
  };
});

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: vi.fn(),
  replaceConfigFile: vi.fn(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../plugins/official-external-plugin-catalog.js", () => ({
  loadConfiguredHostedOfficialExternalPluginCatalogEntries:
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries,
}));

describe("plugins marketplace refresh", () => {
  beforeEach(() => {
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.getRuntimeConfig.mockReset();
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockReset();
  });

  it("refreshes the configured marketplace feed and prints JSON", async () => {
    const config = {
      marketplaces: {
        feeds: { acme: { url: "https://packages.acme.example/openclaw/feed" } },
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "hosted",
      entries: [{ name: "@acme/calendar" }, { name: "@acme/docs" }],
      feed: {
        schemaVersion: 1,
        id: "acme-marketplace",
        generatedAt: "2026-06-23T00:00:00.000Z",
        sequence: 7,
        entries: [],
      },
      metadata: {
        url: "https://packages.acme.example/openclaw/feed",
        status: 200,
        checksum: "feed-sha",
        etag: '"abc"',
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "feed-sha",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith(
      config,
      { feedProfile: "acme", expectedSha256: "feed-sha", requireSnapshotWrite: true },
    );
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith({
      source: "hosted",
      entries: 2,
      feed: {
        id: "acme-marketplace",
        generatedAt: "2026-06-23T00:00:00.000Z",
        sequence: 7,
      },
      metadata: {
        url: "https://packages.acme.example/openclaw/feed",
        status: 200,
        checksum: "feed-sha",
        etag: '"abc"',
      },
    });
  });

  it("normalizes bare SHA-256 pins before refreshing", async () => {
    const config = {
      marketplaces: {
        feeds: { acme: { url: "https://packages.acme.example/openclaw/feed" } },
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "hosted",
      entries: [{ name: "@acme/calendar" }],
      feed: {
        schemaVersion: 1,
        id: "acme-marketplace",
        generatedAt: "2026-06-23T00:00:00.000Z",
        sequence: 7,
        entries: [],
      },
      metadata: {
        url: "https://packages.acme.example/openclaw/feed",
        status: 200,
        checksum: "sha256:abcdef",
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith(
      config,
      {
        feedProfile: "acme",
        expectedSha256: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        requireSnapshotWrite: true,
      },
    );

    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockClear();

    await runPluginMarketplaceRefreshCommand({
      feedProfile: "acme",
      expectedSha256: "sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
      json: true,
    });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith(
      config,
      {
        feedProfile: "acme",
        expectedSha256: "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
        requireSnapshotWrite: true,
      },
    );
  });

  it("reports bundled fallback without failing the command", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error: "hosted catalog feed returned HTTP 503",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins",
        status: 503,
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({});

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("bundled fallback");
    expect(output).toContain("hosted catalog feed returned HTTP 503");
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("redacts query-bearing feed URLs from refresh output", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error:
        "hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
        status: 503,
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceRefreshCommand({
      feedUrl: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
      json: true,
    });

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ url: "https://clawhub.ai/v1/feeds/plugins" }),
        error: "hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins",
      }),
    );

    mocks.defaultRuntime.writeJson.mockClear();
    mocks.defaultRuntime.log.mockClear();

    await runPluginMarketplaceRefreshCommand({
      feedUrl: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
    });

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("https://clawhub.ai/v1/feeds/plugins");
    expect(output).not.toContain("token=secret");
    expect(output).not.toContain("#frag");
  });

  it("fails checksum-pinned refreshes that fall back", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [{ name: "@openclaw/acpx" }],
      error: "hosted catalog feed checksum mismatch: expected sha256:expected",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins",
        status: 200,
        checksum: "sha256:actual",
      },
    });

    const { runPluginMarketplaceRefreshCommand } = await import("./plugins-cli.runtime.js");
    await expect(
      runPluginMarketplaceRefreshCommand({ expectedSha256: "sha256:expected", json: true }),
    ).rejects.toThrow("exit 1");

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ source: "bundled-fallback" }),
    );
    expect(mocks.defaultRuntime.error).toHaveBeenCalledWith(
      "Pinned marketplace feed refresh did not accept a fresh hosted payload (source: bundled-fallback).",
    );
    expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });
});
