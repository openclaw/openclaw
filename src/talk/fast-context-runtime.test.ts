// Fast context runtime tests cover timeout and fast context generation behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveMemorySearchManager: vi.fn(),
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager: mocks.getActiveMemorySearchManager,
}));

import { resolveRealtimeVoiceFastContextConsult } from "./fast-context-runtime.js";

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("resolveRealtimeVoiceFastContextConsult", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mocks.getActiveMemorySearchManager.mockReset();
  });

  it("caps oversized fast-context timeouts before scheduling Node timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    mocks.getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(
      resolveRealtimeVoiceFastContextConsult({
        cfg: {},
        agentId: "main",
        sessionKey: "voice:15550001234",
        config: {
          enabled: true,
          timeoutMs: Number.MAX_SAFE_INTEGER,
          maxResults: 3,
          sources: ["memory", "sessions"],
          fallbackToConsult: true,
        },
        args: { question: "What do you remember?" },
        logger: {},
      }),
    ).resolves.toEqual({ handled: false });

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });

  it("preserves the fast-context timeout error and clears the timer", async () => {
    vi.useFakeTimers();
    const logger = { debug: vi.fn() };
    mocks.getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        search: vi.fn(() => new Promise<never>(() => {})),
      },
    });

    const result = resolveRealtimeVoiceFastContextConsult({
      cfg: {},
      agentId: "main",
      sessionKey: "voice:15550001234",
      config: {
        enabled: true,
        timeoutMs: 25,
        maxResults: 3,
        sources: ["memory", "sessions"],
        fallbackToConsult: true,
      },
      args: { question: "What do you remember?" },
      logger,
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toEqual({ handled: false });
    expect(logger.debug).toHaveBeenCalledWith(
      "[talk] fast context lookup failed: fast context lookup timed out after 25ms",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps truncated context snippets well-formed at UTF-16 boundaries", async () => {
    mocks.getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        search: vi.fn().mockResolvedValue([
          {
            path: "memory.md",
            startLine: 10,
            endLine: 12,
            snippet: `${"a".repeat(698)}😀 tail`,
            source: "memory",
            score: 0.9,
          },
        ]),
      },
    });

    const result = await resolveRealtimeVoiceFastContextConsult({
      cfg: {},
      agentId: "main",
      sessionKey: "voice:15550001234",
      config: {
        enabled: true,
        timeoutMs: 1_000,
        maxResults: 3,
        sources: ["memory", "sessions"],
        fallbackToConsult: true,
      },
      args: { question: "What do you remember?" },
      logger: {},
    });

    expect(result.handled).toBe(true);
    if (!result.handled) {
      return;
    }
    expect(result.result.text).toContain(`${"a".repeat(698)}...`);
    expect(hasLoneSurrogate(result.result.text)).toBe(false);
  });
});
