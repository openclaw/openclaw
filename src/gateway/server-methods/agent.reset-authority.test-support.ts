import { expect, it, vi } from "vitest";
import { createAgentDedupeLifecycle } from "../agent-turn/agent-dedupe-lifecycle.js";
import type { performGatewaySessionReset } from "../session-reset-service.js";
import {
  type getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  requireValue,
  mockCallArg,
  expectRespondError,
  mockMainSessionEntry,
  invokeAgent,
} from "./agent.test-harness.js";

export function registerAgentResetAuthorityTests(mocks: ReturnType<typeof getAgentTestMocks>) {
  const resetRunId = "test-idem-reset-result";
  const sessionKey = "agent:main:main";
  const sessionId = "reset-session-id";
  const reset = (message: string, options: Parameters<typeof invokeAgent>[1]) =>
    invokeAgent({ message, sessionKey, idempotencyKey: resetRunId }, options);

  it.each(["failure", "success"] as const)("preserves ordinary reset %s", async (outcome) => {
    mockMainSessionEntry({ sessionId: "existing-session-id" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.performGatewaySessionReset.mockImplementation(
      async (options: Parameters<typeof performGatewaySessionReset>[0]) => {
        options.assertCurrent?.();
        if (outcome === "failure") {
          return {
            ok: false,
            error: { code: "UNAVAILABLE", message: "reset storage unavailable" },
          };
        }
        options.onCommitted?.({ key: sessionKey, sessionId });
        mockMainSessionEntry({ sessionId });
        return { ok: true, key: sessionKey, entry: { sessionId } };
      },
    );
    const client = operatorWriteCliClient(["operator.admin"]);
    const context = makeContext();
    const respond = await reset("/reset", { client, context });

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledOnce();
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    if (outcome === "success") {
      expect(mockCallArg(respond)).toBe(true);
    } else {
      expectRespondError(respond, { message: "reset storage unavailable" });
      expect(context.dedupe.get(`agent:${resetRunId}`)).toBeUndefined();
    }
  });

  it.each([
    "owned reservation",
    "stop",
    "newer reservation",
    "newer terminal",
    "accepted run",
    "missing reservation",
    "failed reply",
    "failed reply after stop",
    "failed reply after replacement",
    "failed reply with replaced alias",
  ] as const)("preserves reset cleanup ownership for %s", (state) => {
    const context = makeContext();
    const runId = "reset-cleanup-ownership";
    const key = `agent:${runId}`;
    const alias = `agent:exec-approval-followup:${runId}`;
    const replaceReservation = (target: string, status: string, fields = {}) => {
      context.dedupe.set(target, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status, ...fields },
      });
    };
    const hasAlias = state.includes("alias");
    const emit = vi.fn();
    const replyError = state.startsWith("failed reply")
      ? { code: "INVALID_REQUEST", message: "confirmation failed" }
      : undefined;
    const lifecycle = createAgentDedupeLifecycle({
      cfg: {},
      request: { message: "/reset follow up", idempotencyKey: runId },
      runId,
      agentDedupeKeys: hasAlias ? [key, alias] : [key],
      suppressVisibleSessionEffects: false,
      context,
      io: { emitAcceptance: emit, emitFinal: emit },
    });
    lifecycle.reserve(sessionKey, "main");
    const reservation = requireValue(context.dedupe.get(key), "reset reservation missing");
    reservation.requestIdentity = "original-request-fingerprint";
    lifecycle.setCommittedResetCompletion({
      reason: "reset",
      sessionId,
      sessionKey,
      followUpPending: !replyError,
      replyError,
    });
    if (state === "stop" || state.includes("after stop")) {
      replaceReservation(key, "timeout", { stopReason: "rpc" });
    } else if (state === "newer reservation" || state.includes("after replacement")) {
      replaceReservation(key, "accepted", { reservationId: "new-owner" });
    } else if (state === "newer terminal") {
      replaceReservation(key, "ok");
    } else if (state === "accepted run") {
      lifecycle.markAccepted(true);
    } else if (state === "missing reservation") {
      context.dedupe.delete(key);
    }
    if (hasAlias) {
      replaceReservation(alias, "accepted", { reservationId: "new-alias-owner" });
    }
    const before = context.dedupe.get(key);
    const aliasBefore = context.dedupe.get(alias);
    lifecycle.clearUnaccepted();
    lifecycle.clearUnaccepted();
    if (state === "owned reservation") {
      expect(context.dedupe.get(key)).toMatchObject({
        ok: true,
        requestIdentity: "original-request-fingerprint",
        payload: {
          runId,
          status: "ok",
          result: { meta: { agentMeta: { sessionId } } },
        },
      });
    } else if (state === "failed reply" || hasAlias) {
      expect(context.dedupe.get(key)).toMatchObject({
        ok: false,
        error: replyError,
        requestIdentity: "original-request-fingerprint",
      });
      expect(context.dedupe.get(key)?.payload).toBeUndefined();
    } else {
      expect(context.dedupe.get(key)).toBe(before);
    }
    if (hasAlias) {
      expect(context.dedupe.get(alias)).toBe(aliasBefore);
    }
    expect(emit).not.toHaveBeenCalled();
  });
}
