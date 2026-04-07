import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderUsageAuthWithPluginMock = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => null,
);
const ensureAuthProfileStoreMock = vi.fn(() => ({
  profiles: {},
}));

vi.mock("../agents/auth-profiles.js", () => ({
  dedupeProfileIds: (profileIds: string[]) => [...new Set(profileIds)],
  ensureAuthProfileStore: (...args: unknown[]) => ensureAuthProfileStoreMock(...args),
  listProfilesForProvider: () => [],
  resolveApiKeyForProfile: async () => null,
  resolveAuthProfileOrder: () => [],
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageAuthWithPlugin: resolveProviderUsageAuthWithPluginMock,
  };
});

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;

describe("resolveProviderAuths plugin boundary", () => {
  beforeAll(async () => {
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
  });

  beforeEach(() => {
    ensureAuthProfileStoreMock.mockClear();
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(null);
  });

  it("prefers plugin-owned usage auth when available", async () => {
    resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
      token: "plugin-zai-token",
    });

    await expect(
      resolveProviderAuths({
        providers: ["zai"],
      }),
    ).resolves.toEqual([
      {
        provider: "zai",
        token: "plugin-zai-token",
      },
    ]);
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });
});
