import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeActiveMemorySearchHits: vi.fn(),
  getActiveMemoryProviderCore: vi.fn(),
  getActiveMemorySearchManagerCore: vi.fn(),
  isActiveMemoryProviderNative: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  authorizeActiveMemorySearchHits: mocks.authorizeActiveMemorySearchHits,
  getActiveMemoryProviderCore: mocks.getActiveMemoryProviderCore,
  getActiveMemorySearchManagerCore: mocks.getActiveMemorySearchManagerCore,
  isActiveMemoryProviderNative: mocks.isActiveMemoryProviderNative,
}));

import { resolveRealtimeVoiceFastContextConsult } from "./fast-context-runtime.js";

const liveness = { assertCurrent() {} };
const caller = "agent:main:voice:15550001234";
const nativeHit = (id: string, excerpt: string, source?: string) => ({
  reference: { providerId: "records", id },
  excerpt,
  source,
});
const legacyHit = (path: string, snippet: string, source: "memory" | "sessions" = "memory") => ({
  path,
  snippet,
  source,
  startLine: 1,
  endLine: 1,
  score: 1,
});
function nativeSearch(search: () => unknown, close: () => unknown = vi.fn()) {
  mocks.getActiveMemoryProviderCore.mockResolvedValue({ provider: { search, close } });
}
function revocableLiveness() {
  let active = true;
  return {
    revoke() {
      active = false;
    },
    assertCurrent() {
      if (!active) {
        throw new Error("revoked");
      }
    },
  };
}
type ConsultParams = Parameters<typeof resolveRealtimeVoiceFastContextConsult>[0];
function consult(
  config: Partial<ConsultParams["config"]> = {},
  params: Partial<Omit<ConsultParams, "config">> = {},
) {
  return resolveRealtimeVoiceFastContextConsult({
    cfg: {},
    agentId: "main",
    sessionKey: "voice:15550001234",
    config: {
      enabled: true,
      timeoutMs: 1_000,
      maxResults: 2,
      sources: ["memory"],
      fallbackToConsult: true,
      ...config,
    },
    args: { question: "What do you remember?" },
    logger: {},
    liveness,
    ...params,
  });
}

describe("resolveRealtimeVoiceFastContextConsult", () => {
  beforeEach(() => {
    mocks.authorizeActiveMemorySearchHits.mockReset().mockImplementation(async ({ hits }) => hits);
    mocks.getActiveMemoryProviderCore.mockReset();
    mocks.getActiveMemorySearchManagerCore.mockReset();
    mocks.isActiveMemoryProviderNative.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("preserves the fast-context timeout error and clears the timer", async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn() };
    nativeSearch(vi.fn(() => new Promise<never>(() => {})));

    const result = consult(
      { timeoutMs: 25, maxResults: 3, sources: ["memory", "sessions"] },
      { logger },
    );

    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual({ handled: false });
    expect(logger.debug).toHaveBeenCalledWith(
      "[talk] fast context lookup failed: fast context lookup timed out after 25ms",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not split a surrogate pair at the fast-context snippet limit", async () => {
    const safePrefix = "x".repeat(698);
    nativeSearch(async () => ({ hits: [nativeHit("test", `${safePrefix}🚀tail`, "memory")] }));

    const result = await consult({ maxResults: 1 });

    expect(result).toEqual({
      handled: true,
      result: {
        text: expect.stringContaining(`1. [memory] records:test\n${safePrefix}...`),
      },
    });
  });

  it("passes genuine request identity without inventing owner privileges and revokes after return", async () => {
    const close = vi.fn();
    nativeSearch(async () => ({ hits: [nativeHit("visible", "Visible memory")] }), close);
    const result = await consult(
      { sources: ["memory", "sessions"], fallbackToConsult: false },
      { sessionKey: "agent:main:voice:caller" },
    );
    const { context } = mocks.getActiveMemoryProviderCore.mock.calls[0]![0];
    expect(context.authority).toEqual({
      kind: "session",
      sessionKey: "agent:main:voice:caller",
      sandboxed: false,
    });
    expect(() => context.assertCurrent()).toThrow("request has ended");
    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      handled: true,
      result: { text: expect.stringContaining("Visible memory") },
    });
  });

  it.each(["search", "close"])(
    "does not publish hits after caller authority expires during %s",
    async (during) => {
      const live = revocableLiveness();
      const close = vi.fn(async () => {
        if (during === "close") {
          live.revoke();
        }
      });
      nativeSearch(
        vi.fn(async () => {
          if (during === "search") {
            live.revoke();
          }
          return { hits: [nativeHit("secret", "Secret")] };
        }),
        close,
      );
      const result = await consult(
        {},
        {
          sessionKey: "voice:caller",
          liveness: live,
        },
      );
      expect(result).toEqual({ handled: false });
      expect(close).toHaveBeenCalledOnce();
    },
  );

  const legacyConsult = (sources: Array<"memory" | "sessions">, liveCheck = liveness) => {
    mocks.isActiveMemoryProviderNative.mockReturnValue(false);
    return consult({ sources }, { sessionKey: caller, liveness: liveCheck });
  };

  it("removes unauthorized session hits before building caller context", async () => {
    const hits = [
      legacyHit("memory/allowed.md", "Visible memory"),
      legacyHit("sessions/private.jsonl", "Private session secret", "sessions"),
    ];
    mocks.getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: { search: vi.fn().mockResolvedValue(hits) },
    });
    mocks.authorizeActiveMemorySearchHits.mockResolvedValue([hits[0]]);

    const result = await legacyConsult(["memory", "sessions"]);

    expect(mocks.authorizeActiveMemorySearchHits).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      requesterSessionKey: caller,
      sandboxed: false,
      hits,
    });
    expect(result.handled && result.result.text).toContain("Visible memory");
    expect(result.handled && result.result.text).not.toContain("Private session secret");
  });

  it("does not publish hits after the call ends during search", async () => {
    const live = revocableLiveness();
    mocks.getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: {
        search: vi.fn(async () => {
          live.revoke();
          return [legacyHit("MEMORY.md", "Secret")];
        }),
      },
    });

    const result = await legacyConsult(["memory"], live);

    expect(result).toEqual({ handled: false });
  });
  // The voice-call plugin released in v2026.9.7 calls the host helper without `liveness`.
  it("never reads native providers for released callers without liveness and respects fallback", async () => {
    const releasedVoiceCallConsult = (fallbackToConsult: boolean) =>
      consult(
        { fallbackToConsult },
        {
          sessionKey: caller,
          liveness: undefined,
          labels: {
            audienceLabel: "caller",
            contextName: "OpenClaw memory or session context",
          },
        },
      );

    await expect(releasedVoiceCallConsult(true)).resolves.toEqual({ handled: false });
    await expect(releasedVoiceCallConsult(false)).resolves.toEqual({
      handled: true,
      result: { text: expect.stringContaining("No relevant OpenClaw memory or session context") },
    });
    expect(mocks.getActiveMemoryProviderCore).not.toHaveBeenCalled();
  });
});
