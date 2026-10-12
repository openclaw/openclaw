import { describe, expect, it } from "vitest";
import {
  ControlUiReplyCorrelation,
  controlUiRequestSettled,
  summarizeControlUiRequests,
} from "../../scripts/lib/gateway-bench-control-ui-correlation.ts";

function fixture() {
  const correlation = new ControlUiReplyCorrelation();
  const row = correlation.register({
    clientIndex: 0,
    requestId: "request-1",
    sessionKey: "session-1",
    token: "OPENCLAW_E2E_ONE",
    sentMs: 0,
  });
  const event = (state: string, extra = {}) => ({
    state,
    runId: "reply-1",
    sessionKey: row.sessionKey,
    ...extra,
  });
  const final = () =>
    event("final", {
      message: { role: "assistant", content: [{ type: "text", text: row.token }] },
    });
  const ack = () =>
    correlation.acknowledge(row.requestId, { runId: row.requestId, status: "started" }, 1);
  return { correlation, row, event, final, ack };
}

describe("Control UI reply correlation", () => {
  it.each([true, false])("correlates a follow-up when custody arrives first=%s", (custodyFirst) => {
    const { correlation, row, event, final, ack } = fixture();
    ack();
    const custody = () => correlation.observe(event("final", { runId: row.requestId }), 2);
    if (custodyFirst) {
      custody();
    }
    expect(correlation.observe(event("delta", { deltaText: "OPENCLAW_" }), 3)).toEqual({
      kind: "delta",
      sessionKey: row.sessionKey,
      runId: "reply-1",
      firstDeltaMs: 3,
    });
    expect(row.firstDeltaMs).toBeNull();
    expect(correlation.observe(event("delta", { deltaText: "E2E_ONE" }), 4)).toBeUndefined();
    correlation.observe(final(), 5);
    if (!custodyFirst) {
      custody();
    }
    expect(row).toMatchObject({
      ackMs: 1,
      firstDeltaMs: 3,
      finalMs: 5,
      replyRunId: "reply-1",
      error: null,
    });
    expect(controlUiRequestSettled(row)).toBe(true);
  });

  it("retains a final received before the ACK", () => {
    const { correlation, row, final, ack } = fixture();
    correlation.observe(final(), 5);
    expect(controlUiRequestSettled(row)).toBe(false);
    ack();
    expect(controlUiRequestSettled(row)).toBe(true);
    expect(row.firstDeltaMs).toBeNull();
  });

  it("ignores status, empty deltas and custody finals without inventing first-delta timing", () => {
    const { correlation, row, event, final, ack } = fixture();
    ack();
    correlation.observe(event("status", { phase: "starting_model" }), 2);
    correlation.observe(event("delta", { deltaText: "", replace: true }), 3);
    correlation.observe(event("final", { runId: row.requestId }), 4);
    expect(controlUiRequestSettled(row)).toBe(false);
    correlation.observe(final(), 5);
    expect(row.firstDeltaMs).toBeNull();
  });

  it("keeps late custody and duplicate finals from completing the next request", () => {
    const { correlation, row, event, final, ack } = fixture();
    ack();
    correlation.observe(final(), 5);
    const next = correlation.register({
      clientIndex: 0,
      requestId: "request-2",
      sessionKey: row.sessionKey,
      token: "OPENCLAW_E2E_TWO",
      sentMs: 6,
    });
    correlation.observe(event("final", { runId: row.requestId }), 7);
    correlation.observe(final(), 8);
    correlation.observe(event("delta", { deltaText: "stale" }), 9);
    expect(row.finalMs).toBe(5);
    expect(row.firstDeltaMs).toBeNull();
    expect(controlUiRequestSettled(next)).toBe(false);
    expect(() => correlation.observe({ ...final(), runId: "duplicate-reply" }, 10)).toThrow(
      "Multiple visible reply runs",
    );
  });

  it("refuses unexpected tokens, cross-session replies and duplicate request identities", () => {
    const { correlation, row, event, final } = fixture();
    expect(() =>
      correlation.observe(event("final", { message: { role: "assistant", text: "wrong" } }), 2),
    ).toThrow("unexpected synthetic reply");
    correlation.register({
      ...row,
      requestId: "other",
      token: "OTHER",
      sessionKey: "other-session",
    });
    expect(() => correlation.observe({ ...final(), sessionKey: "other-session" }, 2)).toThrow(
      "unexpected synthetic reply",
    );
    expect(() => correlation.register(row)).toThrow("identity duplicated");
  });

  it("records terminal and ACK failures, and refuses an uncorrelated error", () => {
    const { correlation, row, event } = fixture();
    correlation.acknowledge(row.requestId, { runId: "wrong", status: "started" }, 1);
    expect(row.error).toContain("changed the request identity");
    correlation.observe(event("delta", { runId: row.requestId, deltaText: "partial" }), 1.5);
    correlation.observe(
      event("error", { runId: row.requestId, errorMessage: "provider failed" }),
      2,
    );
    expect(row.error).toBe("chat error: provider failed");
    expect(row.firstDeltaMs).toBe(1.5);
    expect(() => correlation.observe(event("aborted"), 3)).toThrow("Uncorrelated");
  });

  it("reports late reply failures after drain without assigning them to a successor", () => {
    const { correlation, row, event, final, ack } = fixture();
    ack();
    expect(correlation.observe(final(), 5)).toBe(row);
    const next = correlation.register({
      clientIndex: 0,
      requestId: "request-2",
      sessionKey: row.sessionKey,
      token: "OPENCLAW_E2E_TWO",
      sentMs: 6,
    });
    expect(summarizeControlUiRequests([row], 10, 1).replies).toBe(1);
    const observed = correlation.observe(event("error", { errorMessage: "late failure" }), 11);
    expect(observed).toBe(row);
    expect(row).toMatchObject({ finalMs: 5, error: "chat error: late failure" });
    expect(next.error).toBeNull();
    expect(summarizeControlUiRequests([row, next], 10, 1)).toMatchObject({
      replies: 0,
      errors: 1,
      pending: 1,
    });
  });

  it("returns incomplete observations for journaling without manufacturing final timing", () => {
    const { correlation, row, event } = fixture();
    const observed = correlation.observe(
      event("delta", { runId: row.requestId, deltaText: "partial" }),
      2,
    );
    expect(observed).toBe(row);
    expect(observed).toMatchObject({ firstDeltaMs: 2, ackMs: null, finalMs: null });
    correlation.acknowledge(row.requestId, { runId: row.requestId, status: {} }, 3);
    expect(row.error).toContain("rejected");
    expect(summarizeControlUiRequests([row], 10, 1)).toMatchObject({ replies: 0, errors: 1 });
  });
});

describe("Control UI load statistics", () => {
  it("uses nearest-rank percentiles, excludes drained replies from throughput and retains missing timings", () => {
    const { row } = fixture();
    const rows = Array.from({ length: 20 }, (_, index) => ({
      ...row,
      ackMs: index + 1,
      firstDeltaMs: index === 0 ? null : index + 2,
      finalMs: index + 10,
    }));
    const result = summarizeControlUiRequests(rows, 20, 1);
    expect(result).toMatchObject({
      started: 20,
      replies: 11,
      drainedReplies: 9,
      errors: 0,
      pending: 0,
      repliesPerSecond: 550,
      ackMs: { count: 20, p50: 10, p95: 19 },
      firstDeltaMs: { count: 19, p50: 12, p95: 21 },
    });
  });

  it("does not count failed or unacknowledged requests as replies", () => {
    const { row } = fixture();
    const result = summarizeControlUiRequests(
      [
        { ...row, finalMs: 5 },
        { ...row, ackMs: 2, finalMs: 6, error: "failed" },
        { ...row, clientIndex: 1, sentMs: 11, ackMs: 12, finalMs: 15 },
      ],
      10,
      2,
    );
    expect(result).toMatchObject({ replies: 0, errors: 1, pending: 1, missingActiveClients: [1] });
    expect(summarizeControlUiRequests([], 10, 1)).toMatchObject({
      replies: 0,
      ackMs: null,
      firstDeltaMs: null,
    });
    expect(() => summarizeControlUiRequests([], 0, 1)).toThrow("positive");
  });
});
