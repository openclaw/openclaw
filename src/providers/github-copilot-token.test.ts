import { describe, expect, it, vi } from "vitest";
import { setAuthCredentialsInDb } from "../infra/state-db/auth-credentials-sqlite.js";
import { useAuthCredentialsTestDb } from "../infra/state-db/test-helpers.auth-credentials.js";
import {
  type CachedCopilotToken,
  deriveCopilotApiBaseUrlFromToken,
  resolveCopilotApiToken,
} from "./github-copilot-token.js";

describe("github-copilot token", () => {
  useAuthCredentialsTestDb();

  it("derives baseUrl from token", () => {
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=proxy.example.com;")).toBe(
      "https://api.example.com",
    );
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=https://proxy.foo.bar;")).toBe(
      "https://api.foo.bar",
    );
  });

  it("uses cache when token is still valid", async () => {
    const now = Date.now();
    const cached: CachedCopilotToken = {
      token: "cached;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
    };
    setAuthCredentialsInDb("github-copilot", "", cached, cached.expiresAt);

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
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "fresh;proxy-ep=https://proxy.contoso.test;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("fresh;proxy-ep=https://proxy.contoso.test;");
    expect(res.baseUrl).toBe("https://api.contoso.test");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
