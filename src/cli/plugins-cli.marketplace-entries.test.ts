// Covers the hosted OpenClaw marketplace feed entries command.
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

vi.mock("../plugins/official-external-plugin-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/official-external-plugin-catalog.js")>();
  return {
    ...actual,
    loadConfiguredHostedOfficialExternalPluginCatalogEntries:
      mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries,
  };
});

describe("plugins marketplace entries", () => {
  beforeEach(() => {
    mocks.defaultRuntime.error.mockClear();
    mocks.defaultRuntime.exit.mockClear();
    mocks.defaultRuntime.log.mockClear();
    mocks.defaultRuntime.writeJson.mockClear();
    mocks.getRuntimeConfig.mockReset();
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockReset();
  });

  it("lists entries from the configured marketplace feed as JSON", async () => {
    const config = {
      marketplaces: {
        feeds: { acme: { url: "https://packages.acme.example/openclaw/feed" } },
        sources: { "acme-npm": { type: "npm" as const } },
      },
    };
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "hosted-snapshot",
      entries: [
        {
          name: "@acme/calendar",
          version: "1.2.3",
          kind: "plugin",
          state: "available",
          publisher: { trust: "official" },
          install: {
            candidates: [{ sourceRef: "acme-npm", package: "@acme/calendar", version: "1.2.3" }],
          },
          openclaw: {
            plugin: { id: "acme-calendar", label: "Acme Calendar" },
          },
        },
      ],
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
      },
      snapshot: {
        body: "{}",
        metadata: {
          url: "https://packages.acme.example/openclaw/feed",
          status: 200,
          checksum: "feed-sha",
        },
        savedAt: "2026-06-23T01:02:03.000Z",
      },
      error: "hosted catalog feed offline mode",
    });

    const { runPluginMarketplaceEntriesCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceEntriesCommand({ feedProfile: "acme", offline: true, json: true });

    expect(mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries).toHaveBeenCalledWith(
      config,
      { feedProfile: "acme", offline: true },
    );
    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "hosted-snapshot",
        entryCount: 1,
        entries: [
          expect.objectContaining({
            id: "acme-calendar",
            label: "Acme Calendar",
            name: "@acme/calendar",
            version: "1.2.3",
            install: expect.objectContaining({ npmSpec: "@acme/calendar@1.2.3" }),
          }),
        ],
      }),
    );
  });

  it("redacts query-bearing feed URLs from entries output", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [],
      error:
        "hosted catalog feed fetch failed for https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
      metadata: {
        url: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
        status: 503,
      },
    });

    const { runPluginMarketplaceEntriesCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceEntriesCommand({
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

    await runPluginMarketplaceEntriesCommand({
      feedUrl: "https://clawhub.ai/v1/feeds/plugins?token=secret#frag",
    });

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("https://clawhub.ai/v1/feeds/plugins");
    expect(output).not.toContain("token=secret");
    expect(output).not.toContain("#frag");
  });

  it("prints bundled fallback entries without failing", async () => {
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.loadConfiguredHostedOfficialExternalPluginCatalogEntries.mockResolvedValue({
      source: "bundled-fallback",
      entries: [
        {
          name: "@openclaw/acpx",
          openclaw: {
            plugin: { id: "acpx", label: "ACP" },
            install: {
              clawhubSpec: "clawhub:@openclaw/acpx",
              npmSpec: "@openclaw/acpx",
              defaultChoice: "npm",
            },
          },
        },
      ],
      error: "hosted catalog feed offline mode",
    });

    const { runPluginMarketplaceEntriesCommand } = await import("./plugins-cli.runtime.js");
    await runPluginMarketplaceEntriesCommand({ offline: true });

    const output = mocks.defaultRuntime.log.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain("bundled fallback");
    expect(output).toContain("acpx");
    expect(output).toContain("@openclaw/acpx");
    expect(output).not.toContain("clawhub:@openclaw/acpx");
    expect(output).toContain("hosted catalog feed offline mode");
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
  });
});
