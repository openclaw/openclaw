import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchClaudeUsage } from "./provider-usage.fetch.claude.js";

const scopeMessage = "missing scope requirement user:profile";
const scopeError = `HTTP 403: ${scopeMessage}`;
const scopeResponse = () => makeResponse(403, { error: { message: scopeMessage } });
const fetchUsage = (payload: unknown) =>
  fetchClaudeUsage(
    "token",
    5000,
    createProviderUsageFetch(async () => makeResponse(200, payload)),
  );

function fallbackFetch(org: Response, usage: Response) {
  return createProviderUsageFetch(async (url, init) => {
    if (url.includes("/api/oauth/usage")) {
      return scopeResponse();
    }
    expect(new Headers(init?.headers).get("Cookie")).toBe("sessionKey=sk-ant-session");
    return url.endsWith("/api/organizations") ? org : usage;
  });
}

describe("fetchClaudeUsage", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("normalizes quota windows, scoped model limits, and extra-usage billing", async () => {
    const reset = "2026-01-12T00:00:00Z";
    const result = await fetchUsage({
      five_hour: { utilization: -5, resets_at: "not-a-date" },
      seven_day: { utilization: 140, resets_at: reset },
      seven_day_sonnet: { utilization: 67 },
      seven_day_opus: { utilization: 90 },
      limits: [
        null,
        [],
        "malformed",
        { percent: 50, scope: [] },
        { percent: 60, scope: { model: [] } },
        { percent: "80", scope: { model: { id: "Numeric" } } },
        { percent: 80, is_active: false, scope: { model: { id: "Inactive" } } },
        { percent: 80, scope: { model: { display_name: " sonnet " } } },
        { percent: 27, scope: { model: { display_name: " ", id: " Fable " } }, resets_at: reset },
        { percent: 90, scope: { model: { display_name: "FABLE" } } },
        { percent: 0, is_active: null, scope: { model: { id: "Zero" } } },
      ],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100000,
        used_credits: 4132,
        utilization: 4.132,
        currency: "usd",
      },
    });
    expect(result.windows).toEqual([
      { label: "5h", usedPercent: 0, resetAt: undefined },
      { label: "Week", usedPercent: 100, resetAt: Date.parse(reset) },
      { label: "Sonnet", usedPercent: 67 },
      { label: "Fable", usedPercent: 27, resetAt: Date.parse(reset) },
      { label: "Zero", usedPercent: 0, resetAt: undefined },
    ]);
    expect(result.billing).toEqual([
      { type: "budget", used: 41.32, limit: 1000, unit: "USD", period: "month" },
    ]);
  });

  it("preserves Opus when sibling windows and activity flags are malformed", async () => {
    const result = await fetchUsage({
      five_hour: { utilization: "18" },
      seven_day: null,
      seven_day_sonnet: {},
      seven_day_opus: { utilization: 44 },
      extra_usage: { is_enabled: "false", utilization: 12 },
    });
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([{ label: "Opus", usedPercent: 44 }]);
  });

  it.each([
    {
      name: "missing amounts",
      extra: {},
      windows: [{ label: "Extra usage", usedPercent: 12 }],
      billing: undefined,
    },
    {
      name: "zero budget",
      extra: { used_credits: 0, monthly_limit: 0, currency: 123 },
      windows: [],
      billing: [{ type: "budget", used: 0, limit: 0, unit: "USD", period: "month" }],
    },
  ])("handles extra usage with $name", async ({ extra, windows, billing }) => {
    const result = await fetchUsage({
      extra_usage: { is_enabled: true, utilization: 12, ...extra },
    });
    expect(result.windows).toEqual(windows);
    expect(result.billing).toEqual(billing);
  });

  it("bounds non-JSON error bodies while preserving the HTTP status", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls === 64) {
            controller.close();
            return;
          }
          pulls++;
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel,
      }),
      { status: 502 },
    );
    const result = await fetchClaudeUsage(
      "token",
      5000,
      createProviderUsageFetch(async () => response),
    );
    expect(result.error).toBe("HTTP 502");
    expect(result.windows).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThan(64);
  });

  it("reports malformed successful JSON", async () => {
    const result = await fetchUsage("{not json");
    expect(result.error).toBe("Malformed usage response");
    expect(result.windows).toEqual([]);
  });

  it("falls back to web usage for missing OAuth scope", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session");
    const fetch = fallbackFetch(
      makeResponse(200, [{ uuid: "org-a" }]),
      makeResponse(200, {
        five_hour: { utilization: 12 },
        limits: [{ percent: 30, scope: { model: { id: "Extra usage" } } }],
        extra_usage: { is_enabled: true, utilization: 25, used_credits: 25, monthly_limit: 100 },
      }),
    );
    const result = await fetchClaudeUsage("token", 5000, fetch);
    expect(result.error).toBeUndefined();
    expect(result.windows).toEqual([
      { label: "5h", usedPercent: 12, resetAt: undefined },
      { label: "Extra usage", usedPercent: 30, resetAt: undefined },
      { label: "Extra usage", usedPercent: 25 },
    ]);
    expect(result.billing).toBeUndefined();
  });

  it("extracts a session key from a Cookie-prefixed header", async () => {
    vi.stubEnv("CLAUDE_WEB_COOKIE", "Cookie: foo=bar; sessionKey=sk-ant-session");
    const fetch = fallbackFetch(
      makeResponse(200, [{ uuid: "org-a" }]),
      makeResponse(200, { five_hour: { utilization: 9 } }),
    );
    expect((await fetchClaudeUsage("token", 5000, fetch)).windows).toEqual([
      { label: "5h", usedPercent: 9, resetAt: undefined },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not attempt web fallback without a valid session key", async () => {
    vi.stubEnv("CLAUDE_AI_SESSION_KEY", "invalid");
    vi.stubEnv("CLAUDE_WEB_SESSION_KEY", "invalid");
    vi.stubEnv("CLAUDE_WEB_COOKIE", "foo=bar");
    const fetch = createProviderUsageFetch(async () => scopeResponse());
    expect((await fetchClaudeUsage("token", 5000, fetch)).error).toBe(scopeError);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    ["org request failed", 500, "boom", 200, {}],
    ["malformed org id", 200, [{ uuid: 123 }], 200, {}],
    ["usage request failed", 200, [{ uuid: "org-a" }], 503, "down"],
    ["empty usage", 200, [{ uuid: "org-a" }], 200, null],
  ] as const)(
    "preserves the OAuth error when fallback has %s",
    async (_name, orgStatus, org, usageStatus, usage) => {
      vi.stubEnv("CLAUDE_AI_SESSION_KEY", "sk-ant-session");
      const result = await fetchClaudeUsage(
        "token",
        5000,
        fallbackFetch(makeResponse(orgStatus, org), makeResponse(usageStatus, usage)),
      );
      expect(result.error).toBe(scopeError);
      expect(result.windows).toEqual([]);
    },
  );
});
