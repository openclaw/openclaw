import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderUsageAuthWithPluginMock = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => null,
);

const resolveProviderCapabilitiesWithPluginMock = vi.fn(() => undefined);

vi.mock("../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-runtime.js")>()),
  resolveProviderCapabilitiesWithPlugin: resolveProviderCapabilitiesWithPluginMock,
  resolveProviderUsageAuthWithPlugin: resolveProviderUsageAuthWithPluginMock,
}));

let resolveProviderAuths: typeof import("./provider-usage.auth.js").resolveProviderAuths;

describe("resolveProviderAuths plugin boundary", () => {
  beforeEach(async () => {
    vi.resetModules();
    resolveProviderUsageAuthWithPluginMock.mockReset();
    resolveProviderUsageAuthWithPluginMock.mockResolvedValue(null);
    ({ resolveProviderAuths } = await import("./provider-usage.auth.js"));
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
  });
});
