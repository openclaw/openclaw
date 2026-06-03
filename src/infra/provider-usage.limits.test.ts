import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the network-backed loader so we can assert WHETHER a usage fetch is even
// attempted for a given credential type (the regression is about defaulting to
// OAuth and borrowing ChatGPT windows for an api-key turn).
const loadMock = vi.hoisted(() => vi.fn());
vi.mock("./provider-usage.load.js", () => ({
  loadProviderUsageSummary: loadMock,
}));

const { getProviderUsageLimits, clearProviderUsageLimitsCacheForTest } = await import(
  "./provider-usage.limits.js"
);

afterEach(() => {
  loadMock.mockReset();
  clearProviderUsageLimitsCacheForTest();
});

describe("getProviderUsageLimits credential awareness", () => {
  it("returns undefined for an api-key OpenAI turn and never fetches", async () => {
    const out = await getProviderUsageLimits("openai", { credentialType: "api-key" });
    expect(out).toBeUndefined();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it("resolves OpenAI limits for an auth-profile turn (mechanism, not credential type)", async () => {
    loadMock.mockResolvedValue({
      updatedAt: 0,
      providers: [{ provider: "openai", displayName: "OpenAI", windows: [] }],
    });
    await getProviderUsageLimits("openai", { credentialType: "auth-profile" });
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("resolves OpenAI limits when the credential type is absent (oauth-eligible)", async () => {
    loadMock.mockResolvedValue({
      updatedAt: 0,
      providers: [{ provider: "openai", displayName: "OpenAI", windows: [] }],
    });
    await getProviderUsageLimits("openai");
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("resolves OpenAI limits for an oauth turn", async () => {
    loadMock.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 40 }],
        },
      ],
    });
    const out = await getProviderUsageLimits("openai", { credentialType: "oauth" });
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(out?.available).toBe(true);
    expect(out?.windows[0]).toMatchObject({ label: "5h", used_pct: 40, pct_left: 60 });
  });

  it("resolves OpenAI limits for a token turn", async () => {
    loadMock.mockResolvedValue({
      updatedAt: 0,
      providers: [{ provider: "openai", displayName: "OpenAI", windows: [] }],
    });
    await getProviderUsageLimits("openai", { credentialType: "token" });
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("resolves non-OpenAI providers regardless of credential type", async () => {
    loadMock.mockResolvedValue({
      updatedAt: 0,
      providers: [
        {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [{ label: "week", usedPercent: 10 }],
        },
      ],
    });
    const out = await getProviderUsageLimits("anthropic");
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(out?.available).toBe(true);
  });
});
