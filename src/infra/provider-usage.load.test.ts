import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import {
  getProviderUsageSnapshotWithPluginMock,
  resetProviderUsageSnapshotWithPluginMock,
} from "./provider-usage-plugin-runtime.test-mocks.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";
import {
  loadUsageWithAuth,
  type ProviderUsageAuth,
  usageNow,
} from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const resolveProviderAuthsMock = vi.hoisted(() =>
  vi.fn<typeof import("./provider-usage.auth.js").resolveProviderAuths>(),
);

vi.mock("./provider-usage.auth.js", async () => {
  const actual = await vi.importActual<typeof import("./provider-usage.auth.js")>(
    "./provider-usage.auth.js",
  );
  return {
    ...actual,
    resolveProviderAuths: resolveProviderAuthsMock,
  };
});

type ProviderAuth = ProviderUsageAuth<typeof loadProviderUsageSummary>;
const googleGeminiCliProvider = "google-gemini-cli" as unknown as ProviderAuth["provider"];
const resolveProviderUsageSnapshotWithPluginMock = getProviderUsageSnapshotWithPluginMock();

describe("provider-usage.load", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetProviderUsageSnapshotWithPluginMock();
    // Default: pass through auth as provided (existing tests pass auth directly)
    resolveProviderAuthsMock.mockImplementation(async (params) => params.auth ?? []);
  });

  it("loads snapshots for copilot gemini codex and xiaomi", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        switch (provider) {
          case "github-copilot":
            return {
              provider,
              displayName: "GitHub Copilot",
              windows: [{ label: "Chat", usedPercent: 20 }],
            };
          case googleGeminiCliProvider:
            return {
              provider,
              displayName: "Gemini CLI",
              windows: [{ label: "Pro", usedPercent: 40 }],
            };
          case "openai-codex":
            return {
              provider,
              displayName: "Codex",
              windows: [{ label: "3h", usedPercent: 12 }],
            };
          case "xiaomi":
            return {
              provider,
              displayName: "Xiaomi",
              windows: [],
            };
          default:
            return null;
        }
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "github-copilot", token: "copilot-token" },
        { provider: googleGeminiCliProvider, token: "gemini-token" },
        { provider: "openai-codex", token: "codex-token", accountId: "acc-1" },
        { provider: "xiaomi", token: "xiaomi-token" },
      ],
      mockFetch,
    );

    expect(summary.providers.map((provider) => provider.provider)).toEqual([
      "github-copilot",
      googleGeminiCliProvider,
      "openai-codex",
      "xiaomi",
    ]);
    expect(
      summary.providers.find((provider) => provider.provider === "github-copilot")?.windows,
    ).toEqual([{ label: "Chat", usedPercent: 20 }]);
    expect(
      summary.providers.find((provider) => provider.provider === googleGeminiCliProvider)
        ?.windows[0]?.label,
    ).toBe("Pro");
    expect(
      summary.providers.find((provider) => provider.provider === "openai-codex")?.windows[0]?.label,
    ).toBe("3h");
    expect(summary.providers.find((provider) => provider.provider === "xiaomi")?.windows).toEqual(
      [],
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty provider list when auth resolves to none", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(loadProviderUsageSummary, [], mockFetch);
    expect(summary).toEqual({ updatedAt: usageNow, providers: [] });
  });

  it("returns unsupported provider snapshots for unknown provider ids", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "unsupported-provider", token: "token-u" }] as unknown as ProviderAuth[],
      mockFetch,
    );
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0]?.error).toBe("Unsupported provider");
  });

  it("filters errors that are marked as ignored", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "HTTP 500",
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });
    ignoredErrors.add("HTTP 500");
    try {
      const summary = await loadUsageWithAuth(
        loadProviderUsageSummary,
        [{ provider: "anthropic", token: "token-a" }],
        mockFetch,
      );
      expect(summary.providers).toEqual([]);
    } finally {
      ignoredErrors.delete("HTTP 500");
    }
  });

  it("keeps usage summary available when one provider fetch rejects", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        if (provider === "anthropic") {
          throw new Error("fetch failed");
        }
        const usageProvider = provider as ProviderUsageSnapshot["provider"];
        return {
          provider: usageProvider,
          displayName: "Codex",
          windows: [{ label: "3h", usedPercent: 12 }],
        };
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "anthropic", token: "token-a" },
        { provider: "openai-codex", token: "token-codex" },
      ],
      mockFetch,
    );

    expect(summary.providers).toEqual([
      {
        provider: "anthropic",
        displayName: "Claude",
        windows: [],
        error: "fetch failed",
      },
      {
        provider: "openai-codex",
        displayName: "Codex",
        windows: [{ label: "3h", usedPercent: 12 }],
      },
    ]);
  });

  it("throws when fetch is unavailable", async () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(
        loadProviderUsageSummary({
          now: usageNow,
          auth: [{ provider: "xiaomi", token: "token-x" }],
          fetch: undefined,
        }),
      ).rejects.toThrow("fetch is not available");
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });

  it("returns empty providers when auth resolution exceeds timeout", async () => {
    // Simulate auth resolution that never settles (e.g. OAuth plugin hangs in non-TTY)
    resolveProviderAuthsMock.mockImplementation(() => new Promise<never>(() => {}));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const summary = await loadProviderUsageSummary({
      now: usageNow,
      timeoutMs: 50,
      providers: ["anthropic"],
      config: {} as OpenClawConfig,
      env: {},
    });

    // Should resolve with empty providers instead of hanging
    expect(summary).toEqual({ updatedAt: usageNow, providers: [] });
    // Should warn that a timeout occurred (not silent)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("provider auth resolution timed out"),
    );
    warnSpy.mockRestore();
  });

  it("does not warn when auth resolution returns no providers", async () => {
    resolveProviderAuthsMock.mockResolvedValueOnce([]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const summary = await loadProviderUsageSummary({
      now: usageNow,
      timeoutMs: 50,
      providers: ["anthropic"],
      config: {} as OpenClawConfig,
      env: {},
    });

    expect(summary).toEqual({ updatedAt: usageNow, providers: [] });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
