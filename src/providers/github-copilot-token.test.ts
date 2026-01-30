import { beforeEach, describe, expect, it, vi } from "vitest";

const loadJsonFile = vi.fn();
const saveJsonFile = vi.fn();
const resolveStateDir = vi.fn().mockReturnValue("/tmp/openclaw-state");

vi.mock("../infra/json-file.js", () => ({
  loadJsonFile,
  saveJsonFile,
}));

vi.mock("../config/paths.js", () => ({
  resolveStateDir,
}));

describe("github-copilot token", () => {
  beforeEach(() => {
    vi.resetModules();
    loadJsonFile.mockReset();
    saveJsonFile.mockReset();
    resolveStateDir.mockReset();
    resolveStateDir.mockReturnValue("/tmp/openclaw-state");
  });

  it("derives baseUrl from token", async () => {
    const { deriveCopilotApiBaseUrlFromToken } = await import("./github-copilot-token.js");

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

    const { resolveCopilotApiToken } = await import("./github-copilot-token.js");

    const fetchImpl = vi.fn();
    const res = await resolveCopilotApiToken({
      githubToken: "gh",
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("fresh;proxy-ep=https://proxy.contoso.test;");
    expect(res.baseUrl).toBe("https://api.contoso.test");
    expect(saveJsonFile).toHaveBeenCalledTimes(1);
  });

  it("uses gho_ tokens directly without exchange", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn();

    const { resolveCopilotApiToken } = await import("./github-copilot-token.js");

    const res = await resolveCopilotApiToken({
      githubToken: "gho_testtoken123456789",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // gho_ tokens should be used directly
    expect(res.token).toBe("gho_testtoken123456789");
    expect(res.source).toBe("copilot-cli:direct");
    expect(res.baseUrl).toBe("https://api.individual.githubcopilot.com");
    // Should NOT call the exchange endpoint
    expect(fetchImpl).not.toHaveBeenCalled();
    // Should cache the token
    expect(saveJsonFile).toHaveBeenCalledTimes(1);
  });

  it("exchanges non-gho tokens via API", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "exchanged;proxy-ep=https://proxy.github.test;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const { resolveCopilotApiToken } = await import("./github-copilot-token.js");

    const res = await resolveCopilotApiToken({
      githubToken: "ghp_regularoauthtoken",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Non-gho tokens should go through the exchange
    expect(res.token).toBe("exchanged;proxy-ep=https://proxy.github.test;");
    expect(String(res.source)).toContain("fetched:");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses COPILOT_API_BASE_URL env var for gho_ tokens", async () => {
    loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn();

    const { resolveCopilotApiToken } = await import("./github-copilot-token.js");

    const res = await resolveCopilotApiToken({
      githubToken: "gho_enterprisetoken",
      env: { COPILOT_API_BASE_URL: "https://api.business.githubcopilot.com" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Should use the env var for baseUrl
    expect(res.token).toBe("gho_enterprisetoken");
    expect(res.baseUrl).toBe("https://api.business.githubcopilot.com");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
