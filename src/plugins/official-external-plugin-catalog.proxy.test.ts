import { describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuard, withTrustedEnvProxyGuardedFetchMode } = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  withTrustedEnvProxyGuardedFetchMode: vi.fn((params: Record<string, unknown>) => ({
    ...params,
    mode: "trusted_env_proxy",
  })),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard,
  withTrustedEnvProxyGuardedFetchMode,
}));

const { loadConfiguredHostedOfficialExternalPluginCatalogEntries } =
  await import("./official-external-plugin-catalog.js");

describe("official external plugin catalog proxy policy", () => {
  it("uses the trusted environment proxy preset for the fixed ClawHub feed", async () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      id: "clawhub-official",
      generatedAt: "2026-07-20T07:23:15.670Z",
      sequence: 108,
      entries: [],
    });
    fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(body, { status: 200 }),
      release: vi.fn(async () => {}),
    });

    const result = await loadConfiguredHostedOfficialExternalPluginCatalogEntries(undefined, {
      snapshotStore: null,
    });

    expect(result.source).toBe("hosted");
    expect(withTrustedEnvProxyGuardedFetchMode).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://clawhub.ai/v1/feeds/plugins",
        requireHttps: true,
        policy: { hostnameAllowlist: ["clawhub.ai"] },
      }),
    );
    expect(fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://clawhub.ai/v1/feeds/plugins",
        mode: "trusted_env_proxy",
        requireHttps: true,
        policy: { hostnameAllowlist: ["clawhub.ai"] },
      }),
    );
  });
});
