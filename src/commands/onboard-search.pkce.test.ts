import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { __testing, setupSearch } from "./onboard-search.js";

const {
  generateSessionId,
  generateCodeVerifier,
  generateCodeChallenge,
  pollFirecrawlAuthStatus,
  waitForFirecrawlAuth,
  applyFirecrawlKeyEverywhere,
  FIRECRAWL_AUTH_STATUS_URL,
} = __testing;

// ---------------------------------------------------------------------------
// PKCE crypto helpers
// ---------------------------------------------------------------------------

describe("PKCE crypto helpers", () => {
  it("generates a 64-char hex session ID", () => {
    const id = generateSessionId();
    expect(id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates unique session IDs", () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
  });

  it("generates a base64url code verifier", () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes → 43 base64url chars
    expect(verifier.length).toBe(43);
  });

  it("generates SHA256 code challenge from verifier", () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);

    // Verify manually
    const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("generates different challenges for different verifiers", () => {
    const v1 = generateCodeVerifier();
    const v2 = generateCodeVerifier();
    expect(generateCodeChallenge(v1)).not.toBe(generateCodeChallenge(v2));
  });
});

// ---------------------------------------------------------------------------
// pollFirecrawlAuthStatus
// ---------------------------------------------------------------------------

describe("pollFirecrawlAuthStatus", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("returns apiKey on successful auth", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ apiKey: "fc-test-key-123", teamName: "TestTeam" }),
    })) as unknown as typeof fetch;

    const result = await pollFirecrawlAuthStatus("session-123", "verifier-abc");
    expect(result).toEqual({ apiKey: "fc-test-key-123", teamName: "TestTeam" });

    expect(global.fetch).toHaveBeenCalledWith(
      FIRECRAWL_AUTH_STATUS_URL,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "session-123", code_verifier: "verifier-abc" }),
      }),
    );
  });

  it("returns null when auth is pending (no apiKey)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const result = await pollFirecrawlAuthStatus("session-123", "verifier-abc");
    expect(result).toBeNull();
  });

  it("returns null on non-OK response", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 404,
    })) as unknown as typeof fetch;

    const result = await pollFirecrawlAuthStatus("session-123", "verifier-abc");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// waitForFirecrawlAuth
// ---------------------------------------------------------------------------

describe("waitForFirecrawlAuth", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    global.fetch = priorFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns result when poll succeeds on second attempt", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      if (callCount >= 2) {
        return {
          ok: true,
          json: async () => ({ apiKey: "fc-polled-key" }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const spin = { update: vi.fn(), stop: vi.fn() };
    const result = await waitForFirecrawlAuth("sess", "verify", spin);

    expect(result).toEqual({ apiKey: "fc-polled-key" });
    expect(spin.update).toHaveBeenCalled();
  });

  it("returns null on timeout", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    // Make Date.now() jump past deadline after first poll.
    const realDateNow = Date.now;
    let callCount = 0;
    Date.now = () => {
      callCount++;
      if (callCount > 2) {
        return realDateNow() + 10 * 60 * 1_000;
      }
      return realDateNow();
    };

    try {
      const spin = { update: vi.fn(), stop: vi.fn() };
      const result = await waitForFirecrawlAuth("sess", "verify", spin);
      expect(result).toBeNull();
    } finally {
      Date.now = realDateNow;
    }
  });

  it("survives network errors and keeps polling", async () => {
    let callCount = 0;
    global.fetch = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("network down");
      }
      return {
        ok: true,
        json: async () => ({ apiKey: "fc-recovered" }),
      };
    }) as unknown as typeof fetch;

    const spin = { update: vi.fn(), stop: vi.fn() };
    const result = await waitForFirecrawlAuth("sess", "verify", spin);

    expect(result).toEqual({ apiKey: "fc-recovered" });
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// applyFirecrawlKeyEverywhere
// ---------------------------------------------------------------------------

describe("applyFirecrawlKeyEverywhere", () => {
  it("sets firecrawl key in both search and fetch config", () => {
    const config: OpenClawConfig = {};
    const result = applyFirecrawlKeyEverywhere(config, "fc-everywhere-key");

    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.firecrawl?.apiKey).toBe("fc-everywhere-key");
    expect(result.tools?.web?.fetch?.provider).toBe("firecrawl");
    expect(result.tools?.web?.fetch?.firecrawl?.apiKey).toBe("fc-everywhere-key");
    expect(result.tools?.web?.fetch?.firecrawl?.enabled).toBe(true);
  });

  it("preserves existing config values", () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: { maxResults: 5 },
          fetch: { maxChars: 10000 },
        },
      },
    };
    const result = applyFirecrawlKeyEverywhere(config, "fc-key");

    expect(result.tools?.web?.search?.maxResults).toBe(5);
    expect(result.tools?.web?.fetch?.maxChars).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// setupSearch integration — Firecrawl OAuth flow
// ---------------------------------------------------------------------------

describe("setupSearch firecrawl OAuth integration", () => {
  const priorFetch = global.fetch;

  const runtime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: ((code: number) => {
      throw new Error(`unexpected exit ${code}`);
    }) as RuntimeEnv["exit"],
  };

  afterEach(() => {
    global.fetch = priorFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function createPrompter(params: { selectValues?: string[]; textValue?: string }): {
    prompter: WizardPrompter;
    notes: Array<{ title?: string; message: string }>;
  } {
    const notes: Array<{ title?: string; message: string }> = [];
    let selectCall = 0;
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async (message: string, title?: string) => {
        notes.push({ title, message });
      }),
      select: vi.fn(async () => {
        const values = params.selectValues ?? ["firecrawl", "browser"];
        return values[selectCall++] ?? values[values.length - 1];
      }) as unknown as WizardPrompter["select"],
      multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
      text: vi.fn(async () => params.textValue ?? ""),
      confirm: vi.fn(async () => true),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };
    return { prompter, notes };
  }

  it("applies firecrawl key to search and fetch on successful OAuth", async () => {
    // Mock fetch: first call is the poll, immediately returns apiKey
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ apiKey: "fc-oauth-key", teamName: "MyTeam" }),
    })) as unknown as typeof fetch;

    const { prompter } = createPrompter({
      selectValues: ["firecrawl", "browser"],
    });

    const result = await setupSearch({}, runtime, prompter);

    expect(result.tools?.web?.search?.provider).toBe("firecrawl");
    expect(result.tools?.web?.search?.firecrawl?.apiKey).toBe("fc-oauth-key");
    expect(result.tools?.web?.fetch?.provider).toBe("firecrawl");
    expect(result.tools?.web?.fetch?.firecrawl?.apiKey).toBe("fc-oauth-key");
  });

  it("falls back gracefully when OAuth times out", async () => {
    // Mock fetch: always returns no apiKey (pending)
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    // Make Date.now jump past deadline after first poll.
    const realDateNow = Date.now;
    let callCount = 0;
    Date.now = () => {
      callCount++;
      if (callCount > 2) {
        return realDateNow() + 10 * 60 * 1_000;
      }
      return realDateNow();
    };

    try {
      const { prompter, notes } = createPrompter({
        selectValues: ["firecrawl", "browser"],
      });

      const result = await setupSearch({}, runtime, prompter);

      // Should return original config unchanged
      expect(result.tools?.web?.search?.firecrawl?.apiKey).toBeUndefined();
      // Should show timeout note
      expect(notes.some((n) => n.message.includes("timed out"))).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });

  it("uses manual key entry when user selects paste option", async () => {
    const { prompter } = createPrompter({
      selectValues: ["firecrawl", "manual"],
      textValue: "fc-manual-key",
    });

    const result = await setupSearch({}, runtime, prompter);

    expect(result.tools?.web?.search?.firecrawl?.apiKey).toBe("fc-manual-key");
    expect(result.tools?.web?.fetch?.firecrawl?.apiKey).toBe("fc-manual-key");
  });

  it("skips OAuth when firecrawl is already authenticated", async () => {
    const config: OpenClawConfig = {
      tools: {
        web: {
          search: {
            firecrawl: { apiKey: "fc-existing" },
          },
        },
      },
    };

    const { prompter, notes } = createPrompter({
      selectValues: ["firecrawl"],
    });

    const result = await setupSearch(config, runtime, prompter);

    expect(result.tools?.web?.search?.firecrawl?.apiKey).toBe("fc-existing");
    expect(notes.some((n) => n.message.includes("already authenticated"))).toBe(true);
  });
});
