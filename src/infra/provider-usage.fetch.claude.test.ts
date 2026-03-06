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
import {
  fetchClaudeUsage,
  resetClaudeUsageRateLimitForTests,
} from "./provider-usage.fetch.claude.js";

const MISSING_SCOPE_MESSAGE = "missing scope requirement user:profile";

function makeMissingScopeResponse() {
  return makeResponse(403, {
    error: { message: MISSING_SCOPE_MESSAGE },
  });
}

function expectMissingScopeError(result: Awaited<ReturnType<typeof fetchClaudeUsage>>) {
  expect(result.error).toContain("HTTP 403:");
  expect(result.error).toContain("user:profile");
  expect(result.windows).toHaveLength(0);
}

function createScopeFallbackFetch(handler: (url: string) => Promise<Response> | Response) {
  return createProviderUsageFetch(async (url) => {
    if (url.includes("/api/oauth/usage")) {
      return makeMissingScopeResponse();
    }
    return handler(url);
  });
}

type ScopeFallbackFetch = ReturnType<typeof createScopeFallbackFetch>;

async function expectMissingScopeWithoutFallback(mockFetch: ScopeFallbackFetch) {
  // Use explicit non-session values so this stays deterministic even when worker env contains
  // real Claude session variables from other suites.
  vi.stubEnv("CLAUDE_AI_SESSION_KEY", "missing-session-key");
  vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "missing-session-key");
  vi.stubEnv("CLAUDE_WEB_COOKIE", "foo=bar");

  const result = await fetchClaudeUsage("token", 5000, mockFetch);
  expectMissingScopeError(result);
  const calledUrls = mockFetch.mock.calls.map(([input]) => toRequestUrl(input));
  expect(calledUrls.length).toBeGreaterThan(0);
  expect(calledUrls.every((url) => url.includes("/api/oauth/usage"))).toBe(true);
}

function makeOrgAResponse() {
  return makeResponse(200, [{ uuid: "org-a" }]);
}

describe("fetchClaudeUsage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    clearConfigCache();
    resetClaudeUsageRateLimitForTests();
  });

  it("parses oauth usage windows", async () => {
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

    expect(result.windows).toEqual([
      { label: "5h", usedPercent: 18, resetAt: new Date(fiveHourReset).getTime() },
      { label: "Week", usedPercent: 54, resetAt: new Date(weekReset).getTime() },
      { label: "Sonnet", usedPercent: 67 },
    ]);
  });

  it("returns HTTP errors with provider message suffix", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(403, {
        error: { message: "scope not granted" },
      }),
    );

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBe("HTTP 403: scope not granted");
    expect(result.windows).toHaveLength(0);
  });

  it("adds rate-limit hint for usage endpoint HTTP 429", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(429, {
        error: { message: "Rate limited. Please try again later." },
      }),
    );

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toContain("HTTP 429:");
    expect(result.error).toContain("backing off usage requests");
    expect(result.error).toContain("model replies may still work");
    expect(result.windows).toHaveLength(0);
  });

  it("uses claude.ai fallback on oauth 429 when CLAUDE_WEB_COOKIE has sessionKey", async () => {
    vi.stubEnv("CLAUDE_WEB_COOKIE", "sessionKey=sk-ant-cookie-session");

    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("/api/oauth/usage")) {
        return makeResponse(429, {
          error: { message: "Rate limited. Please try again later." },
        });
      }
      if (url.endsWith("/api/organizations")) {
        return makeResponse(200, [{ uuid: "org-cookie-429" }]);
      }
      if (url.endsWith("/api/organizations/org-cookie-429/usage")) {
        return makeResponse(200, { five_hour: { utilization: 33 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 33, resetAt: undefined }]);
  });

  it("skips repeated oauth usage calls while 429 cooldown is active", async () => {
    vi.stubEnv("CLAUDE_USAGE_RATE_LIMIT_COOLDOWN_MS", "60000");

    const mockFetch = createProviderUsageFetch(async (url) => {
      if (url.includes("/api/oauth/usage")) {
        return makeResponse(429, {
          error: { message: "Rate limited. Please try again later." },
        });
      }
      return makeResponse(404, "not found");
    });

    const first = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(first.error).toContain("backing off usage requests");

    const second = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(second.error).toContain("cooldown active");

    const oauthCalls = mockFetch.mock.calls
      .map(([input]) => toRequestUrl(input))
      .filter((url) => url.includes("/api/oauth/usage"));
    expect(oauthCalls).toHaveLength(1);
  });

  it("falls back to claude web usage when oauth scope is missing", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session-key");

    const mockFetch = createProviderUsageFetch(async (url, init) => {
      if (url.includes("/api/oauth/usage")) {
        return makeMissingScopeResponse();
      }

      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Cookie).toBe("sessionKey=sk-ant-session-key");

      if (url.endsWith("/api/organizations")) {
        return makeResponse(200, [{ uuid: "org-123" }]);
      }

      if (url.endsWith("/api/organizations/org-123/usage")) {
        return makeResponse(200, {
          five_hour: { utilization: 12 },
        });
      }

      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);

    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 12, resetAt: undefined }]);
  });

  it("parses sessionKey from CLAUDE_WEB_COOKIE for web fallback", async () => {
    vi.stubEnv("CLAUDE_WEB_COOKIE", "sessionKey=sk-ant-cookie-session");

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
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("uses CLAUDE_ORGANIZATION_ID with full CLAUDE_WEB_COOKIE for web fallback", async () => {
    vi.stubEnv(
      "CLAUDE_WEB_COOKIE",
      "sessionKey=sk-ant-cookie-session; anthropic-device-id=device-1; ajs_anonymous_id=anon-1",
    );
    vi.stubEnv("CLAUDE_ORGANIZATION_ID", "org-direct");

    const mockFetch = createProviderUsageFetch(async (url, init) => {
      if (url.includes("/api/oauth/usage")) {
        return makeMissingScopeResponse();
      }
      if (url.endsWith("/api/organizations")) {
        return makeResponse(500, "should not fetch organizations");
      }
      if (url.endsWith("/api/organizations/org-direct/usage")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("Anthropic-Device-Id") ?? headers.get("anthropic-device-id")).toBe(
          "device-1",
        );
        expect(headers.get("Anthropic-Anonymous-Id") ?? headers.get("anthropic-anonymous-id")).toBe(
          "anon-1",
        );
        return makeResponse(200, { seven_day: { utilization: 31 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("token", 5000, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "Week", usedPercent: 31, resetAt: undefined }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("reads Claude web fallback vars from config env.vars", async () => {
    await withTempHome(async (home) => {
      vi.stubEnv("CLAUDE_WEB_COOKIE", "");
      vi.stubEnv("CLAUDE_ORGANIZATION_ID", "");
      vi.stubEnv("CLAUDE_AI_SESSION_KEY", "");
      vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "");

      const stateDir = path.join(home, ".openclaw");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify(
          {
            env: {
              vars: {
                CLAUDE_WEB_COOKIE:
                  "sessionKey=sk-ant-config-session; anthropic-device-id=device-cfg",
                CLAUDE_ORGANIZATION_ID: "org-config",
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const mockFetch = createProviderUsageFetch(async (url) => {
        if (url.includes("/api/oauth/usage")) {
          return makeMissingScopeResponse();
        }
        if (url.endsWith("/api/organizations")) {
          return makeResponse(500, "should not fetch organizations");
        }
        if (url.endsWith("/api/organizations/org-config/usage")) {
          return makeResponse(200, { five_hour: { utilization: 41 } });
        }
        return makeResponse(404, "not found");
      });

      const result = await fetchClaudeUsage("token", 5000, mockFetch);
      expect(result.error).toBeUndefined();
      expect(result.windows).toEqual([{ label: "5h", usedPercent: 41, resetAt: undefined }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  it("falls back to web usage using token when it is a Claude session key", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "");
    vi.stubEnv("CLAUDE_WEB_COOKIE", "");

    const mockFetch = createScopeFallbackFetch(async (url) => {
      if (url.endsWith("/api/organizations")) {
        return makeResponse(200, [{ uuid: "org-token-session" }]);
      }
      if (url.endsWith("/api/organizations/org-token-session/usage")) {
        return makeResponse(200, { five_hour: { utilization: 23 } });
      }
      return makeResponse(404, "not found");
    });

    const result = await fetchClaudeUsage("sk-ant-token-session", 5000, mockFetch);
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "5h", usedPercent: 23, resetAt: undefined }]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("keeps oauth error when fallback session key is unavailable", async () => {
    const mockFetch = createScopeFallbackFetch(async (url) => {
      if (url.endsWith("/api/organizations")) {
        return makeResponse(200, [{ uuid: "org-missing-session" }]);
      }
      return makeResponse(404, "not found");
    });

    await expectMissingScopeWithoutFallback(mockFetch);
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
      orgResponse: makeOrgAResponse,
      usageResponse: () => makeResponse(503, "down"),
    },
    {
      name: "usage request has no windows",
      orgResponse: makeOrgAResponse,
      usageResponse: () => makeResponse(200, {}),
    },
  ])(
    "returns oauth error when web fallback is unavailable: $name",
    async ({ orgResponse, usageResponse }) => {
      vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-fallback");

      const mockFetch = createScopeFallbackFetch(async (url) => {
        if (url.endsWith("/api/organizations")) {
          return orgResponse();
        }
        if (url.endsWith("/api/organizations/org-a/usage")) {
          return usageResponse();
        }
        return makeResponse(404, "not found");
      });

      const result = await fetchClaudeUsage("token", 5000, mockFetch);
      expectMissingScopeError(result);
    },
  );
});
