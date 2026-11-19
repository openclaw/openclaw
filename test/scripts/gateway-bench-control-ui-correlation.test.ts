import { expect, it } from "vitest";
import * as reply from "../../scripts/lib/gateway-bench-control-ui-correlation.ts";

function fixture() {
  const correlation = new reply.ControlUiReplyCorrelation();
  const register = (requestId = "request-1", token = "OPENCLAW_E2E_ONE", sentMs = 0) =>
    correlation.register({ clientIndex: 0, requestId, sessionKey: "session-1", token, sentMs });
  const row = register();
  const observe = (state: string, atMs: number, extra = {}) =>
    correlation.observe({ state, runId: "reply-1", sessionKey: row.sessionKey, ...extra }, atMs);
  const final = (atMs = 5, extra = {}) =>
    observe("final", atMs, {
      message: { role: "assistant", content: [{ type: "text", text: row.token }] },
      ...extra,
    });
  const ack = () =>
    correlation.acknowledge(row.requestId, { runId: row.requestId, status: "started" }, 1);
  return { correlation, row, register, observe, final, ack };
}

it("correlates a follow-up after custody arrives", () => {
  const { row, observe, final, ack } = fixture();
  ack();
  observe("final", 2, { runId: row.requestId });
  expect(observe("delta", 3, { deltaText: "OPENCLAW_" })).toEqual({
    kind: "delta",
    sessionKey: row.sessionKey,
    runId: "reply-1",
    firstDeltaMs: 3,
  });
  expect(row.firstDeltaMs).toBeNull();
  expect(observe("delta", 4, { deltaText: "E2E_ONE" })).toBeUndefined();
  final();
  expect(row).toMatchObject({
    ackMs: 1,
    firstDeltaMs: 3,
    finalMs: 5,
    replyRunId: "reply-1",
    error: null,
  });
  expect(reply.controlUiRequestSettled(row)).toBe(true);
});

it("ignores non-replies and retains finals until ACK arrives", () => {
  const { row, observe, final, ack } = fixture();
  observe("status", 2, { phase: "starting_model" });
  observe("delta", 3, { deltaText: "", replace: true });
  observe("final", 4, { runId: row.requestId });
  expect(reply.controlUiRequestSettled(row)).toBe(false);
  final();
  expect(reply.controlUiRequestSettled(row)).toBe(false);
  ack();
  expect(reply.controlUiRequestSettled(row)).toBe(true);
  expect(row.firstDeltaMs).toBeNull();
});

it("keeps late custody and duplicate finals from completing the next request", () => {
  const { row, register, observe, final, ack } = fixture();
  ack();
  final();
  const next = register("request-2", "OPENCLAW_E2E_TWO", 6);
  observe("final", 7, { runId: row.requestId });
  final(8);
  observe("delta", 9, { deltaText: "stale" });
  expect(row).toMatchObject({ finalMs: 5, firstDeltaMs: null });
  expect(reply.controlUiRequestSettled(next)).toBe(false);
  expect(() => final(10, { runId: "duplicate-reply" })).toThrow("Multiple visible reply runs");
});

it("refuses unexpected tokens, cross-session replies and duplicate request identities", () => {
  const { correlation, row, observe, final } = fixture();
  expect(() => observe("final", 2, { message: { role: "assistant", text: "wrong" } })).toThrow(
    "unexpected synthetic reply",
  );
  correlation.register({
    ...row,
    requestId: "other",
    token: "OTHER",
    sessionKey: "other-session",
  });
  expect(() => final(2, { sessionKey: "other-session" })).toThrow("unexpected synthetic reply");
  expect(() => correlation.register(row)).toThrow("identity duplicated");
});

it("records terminal and ACK failures, and refuses an uncorrelated error", () => {
  const { correlation, row, observe } = fixture();
  correlation.acknowledge(row.requestId, { runId: "wrong", status: "started" }, 1);
  expect(row.error).toContain("changed the request identity");
  observe("delta", 1.5, { runId: row.requestId, deltaText: "partial" });
  observe("error", 2, { runId: row.requestId, errorMessage: "provider failed" });
  expect(row).toMatchObject({ error: "chat error: provider failed", firstDeltaMs: 1.5 });
  expect(() => observe("aborted", 3)).toThrow("Uncorrelated");
});

it("reports late reply failures after drain without assigning them to a successor", () => {
  const { row, register, observe, final, ack } = fixture();
  ack();
  expect(final()).toBe(row);
  const next = register("request-2", "OPENCLAW_E2E_TWO", 6);
  expect(reply.summarizeControlUiRequests([row], 10, 1).replies).toBe(1);
  const observed = observe("error", 11, { errorMessage: "late failure" });
  expect(observed).toBe(row);
  expect(row).toMatchObject({ finalMs: 5, error: "chat error: late failure" });
  expect(next.error).toBeNull();
  const drained = reply.summarizeControlUiRequests([row, next], 10, 1);
  expect(drained).toMatchObject({ replies: 0, errors: 1, pending: 1 });
});
it("does not count failed or unacknowledged requests as replies", () => {
  const { row } = fixture();
  const result = reply.summarizeControlUiRequests(
    [
      { ...row, finalMs: 5 },
      { ...row, ackMs: 2, finalMs: 6, error: "failed" },
      { ...row, clientIndex: 1, sentMs: 11, ackMs: 12, finalMs: 15 },
    ],
    10,
    2,
  );
  expect(result).toMatchObject({ replies: 0, errors: 1, pending: 1, missingActiveClients: [1] });
  const empty = reply.summarizeControlUiRequests([], 10, 1);
  expect(empty).toMatchObject({ replies: 0, ackMs: null, firstDeltaMs: null });
  expect(() => reply.summarizeControlUiRequests([], 0, 1)).toThrow("positive");
});
