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
    loadJsonFile.mockReset();
    saveJsonFile.mockReset();
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

  it("sends Copilot client headers on token exchange", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "tok;proxy-ep=proxy.example.com;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const { resolveCopilotApiToken, COPILOT_CLIENT_HEADERS } =
      await import("./github-copilot-token.js");

    await resolveCopilotApiToken({
      githubToken: "ghp_test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, options] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;

    // Verify all client identification headers are present
    expect(headers["User-Agent"]).toBe(COPILOT_CLIENT_HEADERS["User-Agent"]);
    expect(headers["Editor-Version"]).toBe(COPILOT_CLIENT_HEADERS["Editor-Version"]);
    expect(headers["Editor-Plugin-Version"]).toBe(COPILOT_CLIENT_HEADERS["Editor-Plugin-Version"]);
    expect(headers["X-Github-Api-Version"]).toBe(COPILOT_CLIENT_HEADERS["X-Github-Api-Version"]);
    // Authorization must still be present
    expect(headers.Authorization).toBe("Bearer ghp_test");
  });

  it("setRuntimeApiKeyWithCopilotExchange exchanges token for github-copilot", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "exchanged-jwt",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    // Patch global fetch so the helper can use it
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    try {
      const { setRuntimeApiKeyWithCopilotExchange } = await import("./github-copilot-token.js");

      const authStorage = { setRuntimeApiKey: vi.fn() };
      const result = await setRuntimeApiKeyWithCopilotExchange(
        authStorage,
        "github-copilot",
        "ghp_mytoken",
        { loadJsonFileImpl: loadJsonFile, saveJsonFileImpl: saveJsonFile },
      );

      expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("github-copilot", "exchanged-jwt");
      expect(result).toBe("exchanged-jwt");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("setRuntimeApiKeyWithCopilotExchange passes through for other providers", async () => {
    const { setRuntimeApiKeyWithCopilotExchange } = await import("./github-copilot-token.js");

    const authStorage = { setRuntimeApiKey: vi.fn() };
    const result = await setRuntimeApiKeyWithCopilotExchange(
      authStorage,
      "anthropic",
      "sk-ant-key",
    );

    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "sk-ant-key");
    expect(result).toBe("sk-ant-key");
  });
});
