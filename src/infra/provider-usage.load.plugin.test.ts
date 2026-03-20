import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderUsageSnapshotWithPlugin: (...args: unknown[]) =>
    resolveProviderUsageSnapshotWithPluginMock(...args),
}));

let loadProviderUsageSummary: typeof import("./provider-usage.load.js").loadProviderUsageSummary;

const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);

describe("provider-usage.load plugin boundary", () => {
  beforeEach(async () => {
    vi.resetModules();
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
    ({ loadProviderUsageSummary } = await import("./provider-usage.load.js"));
  });

  it("prefers plugin-owned usage snapshots", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "github-copilot",
      displayName: "Copilot",
      windows: [{ label: "Plugin", usedPercent: 11 }],
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    await expect(
      loadProviderUsageSummary({
        now: usageNow,
        auth: [{ provider: "github-copilot", token: "copilot-token" }],
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual({
      updatedAt: usageNow,
      providers: [
        {
          provider: "github-copilot",
          displayName: "Copilot",
          windows: [{ label: "Plugin", usedPercent: 11 }],
        },
      ],
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "github-copilot",
        context: expect.objectContaining({
          provider: "github-copilot",
          token: "copilot-token",
          timeoutMs: 5_000,
        }),
      }),
    );
  });
});
