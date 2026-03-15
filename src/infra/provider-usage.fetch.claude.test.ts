import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { clearConfigCache } from "../config/config.js";
import {
  createProviderUsageFetch,
  makeResponse,
  toRequestUrl,
} from "../test-utils/provider-usage-fetch.js";
import { fetchClaudeUsage } from "./provider-usage.fetch.claude.js";

const MISSING_SCOPE_MESSAGE = "missing scope requirement user:profile";

function makeMissingScopeResponse() {
  return makeResponse(403, { error: { message: MISSING_SCOPE_MESSAGE } });
}

// Creates a mock fetch that returns the scope-error for OAuth and delegates
// claude.ai requests to the provided handler.
function createScopeFallbackFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
) {
  return createProviderUsageFetch(async (url, init) => {
    if (url.includes("/api/oauth/usage")) {
      return makeMissingScopeResponse();
    }
    return handler(url, init);
  });
}

describe("fetchClaudeUsage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearConfigCache();
  });

  // --- OAuth primary path ---

  it("returns usage windows via OAuth", async () => {
    const fiveHourReset = "2026-01-08T00:00:00Z";
    const weekReset = "2026-01-12T00:00:00Z";

    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Authorization).toBe("Bearer token");
      expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      return makeResponse(200, {
        five_hour: { utilization: 18, resets_at: fiveHourReset },
        seven_day: { utilization: 54, resets_at: weekReset },
        seven_day_sonnet: { utilization: 67 },
      });
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);

    expect(result.error).toBeUndefined();
    expect(result.plan).toBe("OAuth");
    expect(result.windows).toEqual([
      { label: "5h", usedPercent: 18, resetAt: new Date(fiveHourReset).getTime() },
      { label: "Week", usedPercent: 54, resetAt: new Date(weekReset).getTime() },
      { label: "Sonnet", usedPercent: 67 },
    ]);
  });

  it("clamps OAuth usage values and prefers sonnet over opus when both exist", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        five_hour: { utilization: -5 },
        seven_day: { utilization: 140 },
        seven_day_sonnet: { utilization: 40 },
        seven_day_opus: { utilization: 90 },
      }),
    );

    const result = await fetchClaudeUsage("token", 5000, mockFetch);

    expect(result.windows).toEqual([
      { label: "5h", usedPercent: 0, resetAt: undefined },
      { label: "Week", usedPercent: 100, resetAt: undefined },
      { label: "Sonnet", usedPercent: 40 },
    ]);
  });

  it("returns HTTP error with provider message suffix", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(403, { error: { message: "scope not granted" } }),
    );

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBe("HTTP 403: scope not granted");
    expect(result.windows).toHaveLength(0);
  });

  it("omits blank error message suffix on OAuth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(403, { error: { message: "   " } }),
    );

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBe("HTTP 403");
    expect(result.windows).toHaveLength(0);
  });

  it("returns HTTP status error when OAuth body is not JSON", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(502, "bad gateway"));

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBe("HTTP 502");
    expect(result.windows).toHaveLength(0);
  });

  // --- claude.ai web fallback (triggered by 403 missing scope) ---

  it("falls back to claude.ai when OAuth scope is missing", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session-key");

    const mockFetch = createScopeFallbackFetch(async (url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Cookie).toContain("sessionKey=sk-ant-session-key");
      if (url.endsWith("/api/organizations")) {
        return makeResponse(200, [{ uuid: "org-123" }]);
      }
      if (url.endsWith("/api/organizations/org-123/usage")) {
        return makeResponse(200, { five_hour: { utilization: 12 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);

    expect(result.error).toBeUndefined();
    expect(result.plan).toBe("via claude.ai");
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 12, resetAt: undefined }]);
  });

  it("reads session key from CLAUDE_WEB_SESSION_KEY", async () => {
    vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "sk-ant-web-key");

    const mockFetch = createScopeFallbackFetch(async (url) => {
      if (url.endsWith("/api/organizations")) {
        return makeResponse(200, [{ uuid: "org-web" }]);
      }
      if (url.endsWith("/api/organizations/org-web/usage")) {
        return makeResponse(200, { five_hour: { utilization: 10 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.windows).toHaveLength(1);
  });

  it("reads session key from sessionKey in CLAUDE_WEB_COOKIE", async () => {
    vi.stubEnv("CLAUDE_WEB_COOKIE", "sessionKey=sk-ant-cookie-session; other=val");

    const mockFetch = createScopeFallbackFetch(async (url) => {
      if (url.endsWith("/api/organizations")) {
        return makeResponse(200, [{ uuid: "org-cookie" }]);
      }
      if (url.endsWith("/api/organizations/org-cookie/usage")) {
        return makeResponse(200, { seven_day_opus: { utilization: 44 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "Opus", usedPercent: 44 }]);
  });

  it("strips Cookie: prefix from CLAUDE_WEB_COOKIE", async () => {
    vi.stubEnv("CLAUDE_WEB_COOKIE", "Cookie: sessionKey=sk-ant-prefixed");

    const mockFetch = createScopeFallbackFetch(async (url) => {
      if (url.endsWith("/api/organizations")) {
        return makeResponse(200, [{ uuid: "org-prefix" }]);
      }
      if (url.endsWith("/api/organizations/org-prefix/usage")) {
        return makeResponse(200, { five_hour: { utilization: 9 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 9, resetAt: undefined }]);
  });

  it("uses token directly as web session key when it starts with sk-ant-", async () => {
    vi.stubEnv("CLAUDE_ORGANIZATION_ID", "org-token");

    const mockFetch = createScopeFallbackFetch(async (url, init) => {
      if (url.endsWith("/api/organizations/org-token/usage")) {
        const headers = (init?.headers as Record<string, string> | undefined) ?? {};
        expect(headers.Cookie).toContain("sessionKey=sk-ant-token-direct");
        return makeResponse(200, { five_hour: { utilization: 5 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("sk-ant-token-direct", 5000, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.plan).toBe("via claude.ai");
    expect(result.windows).toHaveLength(1);
  });

  it("skips org lookup when CLAUDE_ORGANIZATION_ID is set", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session");
    vi.stubEnv("CLAUDE_ORGANIZATION_ID", "org-direct");

    const mockFetch = createScopeFallbackFetch(async (url) => {
      if (url.endsWith("/api/organizations")) {
        throw new Error("should not fetch organizations");
      }
      if (url.endsWith("/api/organizations/org-direct/usage")) {
        return makeResponse(200, { seven_day: { utilization: 31 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "Week", usedPercent: 31, resetAt: undefined }]);
    // 1 OAuth call + 1 usage call (no org lookup)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("passes device-id and anonymous-id headers from CLAUDE_WEB_COOKIE", async () => {
    vi.stubEnv(
      "CLAUDE_WEB_COOKIE",
      "sessionKey=sk-ant-session; anthropic-device-id=device-1; ajs_anonymous_id=anon-1",
    );
    vi.stubEnv("CLAUDE_ORGANIZATION_ID", "org-hdr");

    const mockFetch = createScopeFallbackFetch(async (url, init) => {
      if (url.endsWith("/api/organizations/org-hdr/usage")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("Anthropic-Device-Id") ?? headers.get("anthropic-device-id")).toBe(
          "device-1",
        );
        expect(headers.get("Anthropic-Anonymous-Id") ?? headers.get("anthropic-anonymous-id")).toBe(
          "anon-1",
        );
        return makeResponse(200, { seven_day: { utilization: 55 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBeUndefined();
  });

  it("reads session key and org from config env.vars", async () => {
    await withTempHome(async (home) => {
      vi.stubEnv("CLAUDE_AI_SESSION_KEY", "");
      vi.stubEnv("CLAUDE_WEB_COOKIE", "");
      vi.stubEnv("CLAUDE_ORGANIZATION_ID", "");

      const stateDir = path.join(home, ".openclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify(
          {
            env: {
              vars: {
                CLAUDE_WEB_COOKIE: "sessionKey=sk-ant-config-session",
                CLAUDE_ORGANIZATION_ID: "org-config",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const mockFetch = createScopeFallbackFetch(async (url) => {
        if (url.endsWith("/api/organizations/org-config/usage")) {
          return makeResponse(200, { five_hour: { utilization: 41 } });
        }
        return makeResponse(404, "not found");
      });

      const result = await fetchClaudeUsage("token", 5000, mockFetch);
      expect(result.error).toBeUndefined();
      expect(result.windows).toEqual([{ label: "5h", usedPercent: 41, resetAt: undefined }]);
      // 1 OAuth call + 1 usage call
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("returns OAuth error when web fallback session key is unavailable", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_COOKIE", "");

    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("/api/oauth/usage")) {
        return makeMissingScopeResponse();
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toContain("HTTP 403");
    expect(result.windows).toHaveLength(0);

    const calledUrls = mockFetch.mock.calls.map(([input]) => toRequestUrl(input));
    expect(calledUrls.every((u) => u.includes("/api/oauth/usage"))).toBe(true);
  });

  it.each([
    {
      name: "org list request fails",
      orgResponse: () => makeResponse(500, "boom"),
      usageResponse: () => makeResponse(200, {}),
    },
    {
      name: "org list has no id",
      orgResponse: () => makeResponse(200, [{}]),
      usageResponse: () => makeResponse(200, {}),
    },
    {
      name: "usage request fails",
      orgResponse: () => makeResponse(200, [{ uuid: "org-a" }]),
      usageResponse: () => makeResponse(503, "down"),
    },
    {
      name: "usage request has no windows",
      orgResponse: () => makeResponse(200, [{ uuid: "org-a" }]),
      usageResponse: () => makeResponse(200, {}),
    },
  ])(
    "returns OAuth error when web fallback is unavailable: $name",
    async ({ orgResponse, usageResponse }) => {
      vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-fallback");

      const mockFetch = createScopeFallbackFetch(async (url) => {
        if (url.endsWith("/api/organizations")) {
          return orgResponse();
        }
        if (url.includes("/api/organizations/") && url.endsWith("/usage")) {
          return usageResponse();
        }
        return makeResponse(404, "not found");
      });

      const result = await fetchClaudeUsage("token", 5000, mockFetch);
      expect(result.error).toContain("HTTP 403");
      expect(result.windows).toHaveLength(0);
    },
  );
});
