import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

const { formatFeedSearchEntry, resolveCatalogFeedSearchOptions } =
  await import("./feed-search-options.js");

describe("feed search CLI options", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
  });

  it("quotes feed install specs in native search hints", () => {
    const formatted = formatFeedSearchEntry({
      id: "calendar-helper",
      type: "plugin",
      sourceId: "company-approved",
      feedId: "company-feed",
      install: {
        source: "clawhub",
        spec: "safe-package && curl example.invalid",
      },
    });

    expect(formatted).toContain(
      "Install: openclaw plugins install 'clawhub:safe-package && curl example.invalid'",
    );
  });

  it("uses npm install specs in native search hints", () => {
    const formatted = formatFeedSearchEntry({
      id: "calendar-helper",
      type: "plugin",
      sourceId: "company-approved",
      feedId: "company-feed",
      install: {
        source: "npm",
        npmSpec: "@company/calendar-helper@1.2.3",
      },
    });

    expect(formatted).toContain("Install: openclaw plugins install @company/calendar-helper@1.2.3");
  });

  it("keeps default search disabled when feed search config cannot be read", async () => {
    mocks.readConfigFileSnapshot.mockRejectedValueOnce(new Error("bad feeds config"));

    await expect(resolveCatalogFeedSearchOptions({})).resolves.toEqual({ enabled: false });
  });

  it("preserves an explicit empty default feed source list", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: {
        plugins: {
          entries: {
            feeds: {
              enabled: true,
              config: {
                search: { default: true, sources: [] },
              },
            },
          },
        },
      },
    });

    await expect(resolveCatalogFeedSearchOptions({})).resolves.toEqual({
      enabled: true,
      sourceIds: [],
    });
  });

  it("fails explicit feed search when the Feeds plugin is disabled", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: {
        plugins: {
          entries: {
            feeds: {
              enabled: false,
              config: {
                search: { default: true },
              },
            },
          },
        },
      },
    });

    await expect(resolveCatalogFeedSearchOptions({ catalogFeeds: true })).rejects.toThrow(
      "Catalog feed search requires the Feeds plugin to be enabled and allowed in config.",
    );
  });

  it("fails explicit feed search when feed search config cannot be read", async () => {
    mocks.readConfigFileSnapshot.mockRejectedValueOnce(new Error("bad feeds config"));

    await expect(resolveCatalogFeedSearchOptions({ catalogFeeds: true })).rejects.toThrow(
      "Catalog feed search requires the Feeds plugin to be enabled and allowed in config.",
    );
  });

  it("keeps default search disabled when the Feeds plugin is disabled", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: {
        plugins: {
          entries: {
            feeds: {
              enabled: false,
              config: {
                search: { default: true },
              },
            },
          },
        },
      },
    });

    await expect(resolveCatalogFeedSearchOptions({})).resolves.toEqual({ enabled: false });
  });
});
