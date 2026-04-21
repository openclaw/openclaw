import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const resolveProviderUsageAuthWithPluginMock = vi.fn(
  async (..._args: unknown[]): Promise<unknown> => null,
);
const ensureAuthProfileStoreMock = vi.fn(() => ({
  profiles: {},
}));

vi.mock("../agents/auth-profiles.js", () => ({
  dedupeProfileIds: (profileIds: string[]) => [...new Set(profileIds)],
  ensureAuthProfileStore: () => ensureAuthProfileStoreMock(),
  hasAnyAuthProfileStoreSource: () => false,
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

async function withTempHome<T>(fn: (homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-usage-"));
  try {
    return await fn(homeDir);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

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

  it("skips plugin usage auth when requested and no direct credential source exists", async () => {
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuths({
          providers: ["zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toEqual([]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).not.toHaveBeenCalled();
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("keeps plugin usage auth when a shared legacy plugin credential source exists", async () => {
    await withTempHome(async (homeDir) => {
      fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "agent", "auth.json"),
        `${JSON.stringify({ "z-ai": { access: "legacy-zai-token" } })}\n`,
      );
      resolveProviderUsageAuthWithPluginMock.mockResolvedValueOnce({
        token: "legacy-zai-token",
      });
      await expect(
        resolveProviderAuths({
          providers: ["zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: { HOME: homeDir },
        }),
      ).resolves.toEqual([
        {
          provider: "zai",
          token: "legacy-zai-token",
        },
      ]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "zai",
      }),
    );
    expect(ensureAuthProfileStoreMock).not.toHaveBeenCalled();
  });

  it("skips plugin usage auth per provider when only another provider has direct credentials", async () => {
    await withTempHome(async (homeDir) => {
      await expect(
        resolveProviderAuths({
          providers: ["anthropic", "zai"],
          skipPluginAuthWithoutCredentialSource: true,
          env: {
            HOME: homeDir,
            ANTHROPIC_API_KEY: "sk-ant",
          },
        }),
      ).resolves.toEqual([
        {
          provider: "anthropic",
          token: "sk-ant",
        },
      ]);
    });

    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledTimes(1);
    expect(resolveProviderUsageAuthWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
      }),
    );
  });
});
