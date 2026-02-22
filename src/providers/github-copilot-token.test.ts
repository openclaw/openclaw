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

  it("uses cache when token is still valid and githubToken matches", async () => {
    const now = Date.now();
    const crypto = await import("node:crypto");
    const ghHash = crypto.createHash("sha256").update("gh").digest("hex");
    loadJsonFile.mockReturnValue({
      token: "cached;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
      githubTokenHash: ghHash,
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

  it("ignores cache when githubToken does not match cached hash", async () => {
    const now = Date.now();
    const crypto = await import("node:crypto");
    const account1Hash = crypto.createHash("sha256").update("ghu_account1").digest("hex");
    loadJsonFile.mockReturnValue({
      token: "account1-token;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
      githubTokenHash: account1Hash,
    });

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "account2-token;proxy-ep=https://proxy.example.com;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const res = await resolveCopilotApiToken({
      githubToken: "ghu_account2",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("account2-token;proxy-ep=https://proxy.example.com;");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(saveJsonFile).toHaveBeenCalledTimes(1);
    const saved = saveJsonFile.mock.calls[0][1];
    const account2Hash = crypto.createHash("sha256").update("ghu_account2").digest("hex");
    expect(saved.githubTokenHash).toBe(account2Hash);
  });

  it("re-fetches when cache has no githubTokenHash (backward compat)", async () => {
    const now = Date.now();
    loadJsonFile.mockReturnValue({
      token: "old-cached;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
      // no githubTokenHash — pre-upgrade cache file
    });

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "fresh;proxy-ep=https://proxy.example.com;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("fresh;proxy-ep=https://proxy.example.com;");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(saveJsonFile).toHaveBeenCalledTimes(1);
    expect(saveJsonFile.mock.calls[0][1].githubTokenHash).toBeTruthy();
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
