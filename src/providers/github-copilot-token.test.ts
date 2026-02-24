import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveCopilotApiBaseUrlFromToken,
  resolveCopilotApiToken,
} from "./github-copilot-token.js";

describe("github-copilot token", () => {
  const loadJsonFile = vi.fn();
  const saveJsonFile = vi.fn();
  const cachePath = "/tmp/openclaw-state/credentials/github-copilot.token.json";

  beforeEach(() => {
    loadJsonFile.mockClear();
    saveJsonFile.mockClear();
  });

  it("derives baseUrl from token", async () => {
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=proxy.example.com;")).toBe(
      "https://api.example.com",
    );
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=https://proxy.foo.bar;")).toBe(
      "https://api.foo.bar",
    );
  });

  it("uses cache when token is still valid", async () => {
    const now = Date.now();
    loadJsonFile.mockReturnValue({
      token: "cached;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
    });

    const fetchImpl = vi.fn();
    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("cached;proxy-ep=proxy.example.com;");
    expect(res.baseUrl).toBe("https://api.example.com");
    expect(String(res.source)).toContain("cache:");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses separate cache files per githubToken to prevent cross-account leakage", async () => {
    const now = Date.now();
    const account1Cache = {
      token: "account1;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
    };
    const account2Cache = {
      token: "account2;proxy-ep=proxy.other.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
    };

    // Track which cache paths are read/written per githubToken
    const cacheStore = new Map<string, unknown>();
    const loadImpl = vi.fn((p: string) => cacheStore.get(p));
    const saveImpl = vi.fn((p: string, v: unknown) => cacheStore.set(p, v));
    const fetchImpl = vi.fn();

    // Resolve for account1 (cache miss -> fetch)
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: account1Cache.token,
        expires_at: Math.floor(account1Cache.expiresAt / 1000),
      }),
    });

    const res1 = await resolveCopilotApiToken({
      githubToken: "ghu_account1_token",
      loadJsonFileImpl: loadImpl,
      saveJsonFileImpl: saveImpl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Resolve for account2 (cache miss -> fetch)
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        token: account2Cache.token,
        expires_at: Math.floor(account2Cache.expiresAt / 1000),
      }),
    });

    const res2 = await resolveCopilotApiToken({
      githubToken: "ghu_account2_token",
      loadJsonFileImpl: loadImpl,
      saveJsonFileImpl: saveImpl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Each account gets its own token
    expect(res1.token).toBe(account1Cache.token);
    expect(res2.token).toBe(account2Cache.token);

    // Two separate cache files were written (different paths)
    expect(saveImpl).toHaveBeenCalledTimes(2);
    const path1 = saveImpl.mock.calls[0][0];
    const path2 = saveImpl.mock.calls[1][0];
    expect(path1).not.toBe(path2);

    // Now resolve again for account2 -- should hit cache, not fetch
    fetchImpl.mockClear();
    const res2Again = await resolveCopilotApiToken({
      githubToken: "ghu_account2_token",
      loadJsonFileImpl: loadImpl,
      saveJsonFileImpl: saveImpl,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res2Again.token).toBe(account2Cache.token);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and stores token when cache is missing", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "fresh;proxy-ep=https://proxy.contoso.test;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const { resolveCopilotApiToken } = await import("./github-copilot-token.js");

    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("fresh;proxy-ep=https://proxy.contoso.test;");
    expect(res.baseUrl).toBe("https://api.contoso.test");
    expect(saveJsonFile).toHaveBeenCalledTimes(1);
  });
});
