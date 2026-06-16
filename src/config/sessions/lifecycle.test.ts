import { describe, expect, it } from "vitest";
import { resolveTerminalMainSessionTranscriptRegistryCheck } from "./lifecycle.js";
import type { SessionEntry } from "./types.js";

const baseEntry = (overrides: Partial<SessionEntry>): SessionEntry => ({
  sessionId: "test-session-id",
  sessionFile: "test.jsonl",
  updatedAt: 1_000_000,
  startedAt: 900_000,
  ...overrides,
});

describe("resolveTerminalMainSessionTranscriptRegistryCheck", () => {
  it("returns a transcript-registry check for a clean done main session", () => {
    const check = resolveTerminalMainSessionTranscriptRegistryCheck({
      entry: baseEntry({ status: "done", endedAt: 1_000_500, updatedAt: 1_000_700 }),
      sessionScope: "per-sender",
      sessionKey: "agent:main:main",
      agentId: "main",
      mainKey: "main",
    });
    expect(check).toEqual({
      sessionId: "test-session-id",
      registryTimestampMs: 1_000_700,
    });
  });

  it("skips paused main sessions even when endedAt is present so the queued continuation is not falsely terminated", () => {
    // A yielded paused main session carries a positive `endedAt` from the
    // sessions_yield event, but its queued continuation is still pending.
    // Treating it as terminal would let agent dispatch, auto-reply, and
    // session-command callers run transcript freshness/rotation logic and
    // break the nonterminal invariant the paused status preserves.
    const check = resolveTerminalMainSessionTranscriptRegistryCheck({
      entry: baseEntry({
        status: "paused",
        endedAt: 1_000_500,
        updatedAt: 1_000_700,
        pauseReason: "sessions_yield",
      }),
      sessionScope: "per-sender",
      sessionKey: "agent:main:main",
      agentId: "main",
      mainKey: "main",
    });
    expect(check).toBeUndefined();
  });

  it("skips paused main sessions even when no endedAt is present", () => {
    const check = resolveTerminalMainSessionTranscriptRegistryCheck({
      entry: baseEntry({ status: "paused", pauseReason: "sessions_yield" }),
      sessionScope: "per-sender",
      sessionKey: "agent:main:main",
      agentId: "main",
      mainKey: "main",
    });
    expect(check).toBeUndefined();
  });

  it("skips failed entries so retry/recovery callers can reuse the transcript", () => {
    const check = resolveTerminalMainSessionTranscriptRegistryCheck({
      entry: baseEntry({ status: "failed", endedAt: 1_000_500, updatedAt: 1_000_700 }),
      sessionScope: "per-sender",
      sessionKey: "agent:main:main",
      agentId: "main",
      mainKey: "main",
    });
    expect(check).toBeUndefined();
  });

  it("returns undefined for non-main sessions", () => {
    const check = resolveTerminalMainSessionTranscriptRegistryCheck({
      entry: baseEntry({ status: "done", endedAt: 1_000_500, updatedAt: 1_000_700 }),
      sessionScope: "per-sender",
      sessionKey: "agent:main:other-key",
      agentId: "main",
      mainKey: "main",
    });
    expect(check).toBeUndefined();
  });
});
