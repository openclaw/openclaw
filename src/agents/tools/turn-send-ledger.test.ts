import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTurnSendTargetKey,
  peekTurnSendCount,
  recordTurnSend,
  resetTurnSendLedgerForTest,
  TURN_SEND_LEDGER_TTL_MS,
} from "./turn-send-ledger.js";

afterEach(() => {
  resetTurnSendLedgerForTest();
  vi.useRealTimers();
});

describe("turn-send-ledger", () => {
  it("increments per (runId, target) within one turn", () => {
    const base = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };
    expect(recordTurnSend(base)).toBe(1);
    expect(recordTurnSend(base)).toBe(2);
    expect(recordTurnSend(base)).toBe(3);
  });

  it("keeps separate counts per target inside the same turn", () => {
    expect(recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:b" })).toBe(1);
    expect(recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
  });

  it("resets counts when the runId changes (new turn)", () => {
    expect(recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2 - 1);
    expect(recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // New run for the same session starts the count over.
    expect(recordTurnSend({ sessionKey: "s1", runId: "run-2", targetKey: "tg:a" })).toBe(1);
  });

  it("isolates counts across sessions", () => {
    expect(recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(recordTurnSend({ sessionKey: "s2", runId: "run-1", targetKey: "tg:a" })).toBe(1);
    expect(recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
  });

  it("peeks without mutating and returns 0 for a different turn", () => {
    recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" });
    recordTurnSend({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" });
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // Peeking must not increment.
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-1", targetKey: "tg:a" })).toBe(2);
    // A newer turn has no prior sends recorded.
    expect(peekTurnSendCount({ sessionKey: "s1", runId: "run-2", targetKey: "tg:a" })).toBe(0);
    // Unknown session/target reads as zero.
    expect(peekTurnSendCount({ sessionKey: "s9", runId: "run-1", targetKey: "tg:a" })).toBe(0);
  });

  it("prunes sessions idle past the TTL on write", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    recordTurnSend({ sessionKey: "stale", runId: "run-1", targetKey: "tg:a" });
    // Advance beyond the TTL, then write for a different session so the prune runs.
    vi.setSystemTime(10 * 60_000 + 1);
    recordTurnSend({ sessionKey: "fresh", runId: "run-1", targetKey: "tg:a" });
    // The stale session's slot is gone: its next write starts a fresh count.
    expect(peekTurnSendCount({ sessionKey: "stale", runId: "run-1", targetKey: "tg:a" })).toBe(0);
  });

  it("expires a capped slot on peek once past the TTL, unblocking a stuck turn", () => {
    const key = { sessionKey: "s1", runId: "run-1", targetKey: "tg:a" };
    // `now` is injected so the test needs no timers and stays deterministic.
    expect(recordTurnSend(key, 0)).toBe(1);
    expect(recordTurnSend(key, 0)).toBe(2);
    expect(peekTurnSendCount(key, 0)).toBe(2);
    // Past the TTL the capped slot would otherwise keep returning 2 and block forever,
    // since the cap check peeks before record (the only other pruner) can reset it.
    expect(peekTurnSendCount(key, TURN_SEND_LEDGER_TTL_MS + 1)).toBe(0);
    // A record after expiry restarts the turn's budget with the same runId.
    expect(recordTurnSend(key, TURN_SEND_LEDGER_TTL_MS + 2)).toBe(1);
  });

  it("builds the canonical channel/account/target key shared by both send tools", () => {
    // Byte-identical to resolveOutboundActionRoute in message-tool: an absent account
    // folds to "default" and the channel is normalized.
    expect(buildTurnSendTargetKey({ channel: "reef", target: "reef:peer-agent" })).toBe(
      "reef\u0000default\u0000reef:peer-agent",
    );
    expect(
      buildTurnSendTargetKey({ channel: "reef", accountId: "primary", target: "reef:peer-agent" }),
    ).toBe("reef\u0000primary\u0000reef:peer-agent");
  });
});
