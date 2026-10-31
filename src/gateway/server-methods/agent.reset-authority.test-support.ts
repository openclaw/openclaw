import { expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { patchSessionEntryTarget } from "../../config/sessions/session-accessor.js";
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

type PatchOptions = NonNullable<Parameters<typeof patchSessionEntryTarget>[2]>;

export function registerAgentResetAuthorityTests(mocks: ReturnType<typeof getAgentTestMocks>) {
  const resetRunId = "test-idem-reset-closed-authority";
  const sessionKey = "agent:main:main";
  const sessionId = "reset-session-id";
  const reset = (message: string, options: Parameters<typeof invokeAgent>[1]) =>
    invokeAgent({ message, sessionKey, idempotencyKey: resetRunId }, options);

  it.each([
    "before ingress",
    "before reset commit",
    "after reset commit",
    "after reset commit with follow-up",
    "during follow-up persistence",
    "reset fails",
    "never",
  ] as const)("contains /reset effects when runtime authority closes %s", async (closeAt) => {
    let authorityActive = closeAt !== "before ingress";
    let resetCommitted = false;
    const closesAfterCommit = closeAt.startsWith("after reset commit");
    const closesDuringFollowUp = closeAt === "during follow-up persistence";
    const hasFollowUp = closeAt.endsWith("with follow-up") || closesDuringFollowUp;
    const message = hasFollowUp ? "/reset continue working" : "/reset";
    let followUpCommitted = false;
    mockMainSessionEntry({
      sessionId: closesDuringFollowUp ? sessionId : "existing-session-id",
      ...(closesDuringFollowUp ? { lifecycleRevision: "before-reset" } : {}),
    });
    mocks.performGatewaySessionReset.mockClear();
    if (closesDuringFollowUp) {
      mocks.patchSessionEntryTarget.mockImplementationOnce(
        async (scope, _update, options: PatchOptions) => {
          expect(scope).toMatchObject({ agentId: "main", target: { canonicalKey: sessionKey } });
          expect(options.fallbackEntry).toMatchObject({
            sessionId,
            lifecycleRevision: "after-reset",
          });
          expect([resetCommitted, authorityActive]).toEqual([true, true]);
          await Promise.resolve();
          authorityActive = false;
          requireValue(options.workerGuard?.source, "missing follow-up authority guard")();
          followUpCommitted = true;
          return null;
        },
      );
    }
    mocks.performGatewaySessionReset.mockImplementation(
      async (options: Parameters<typeof performGatewaySessionReset>[0]) => {
        await Promise.resolve();
        if (closeAt === "before reset commit") {
          authorityActive = false;
        }
        options.assertCurrent?.();
        if (closeAt === "reset fails") {
          authorityActive = false;
          return {
            ok: false,
            error: { code: "UNAVAILABLE", message: "reset storage unavailable" },
          };
        }
        resetCommitted = true;
        options.onCommitted?.({ key: sessionKey, sessionId });
        mockMainSessionEntry({
          sessionId,
          ...(closesDuringFollowUp ? { lifecycleRevision: "after-reset" } : {}),
        });
        if (closesAfterCommit) {
          authorityActive = false;
        }
        return { ok: true, key: sessionKey, entry: { sessionId } };
      },
    );
    const client = operatorWriteCliClient(["operator.admin"]);
    const operationalRunInstance = createOperationalRunInstanceRef("reset-caller");
    client.internal = {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "test-generation",
          claimId: "reset-caller-claim",
        },
      },
    };
    const context = makeContext();
    context.validateAgentRuntimeApprovalAuthority = () => authorityActive;

    const respond = await reset(message, { client, context });

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(
      closeAt === "before ingress" ? 0 : 1,
    );
    expect(resetCommitted).toBe(closesAfterCommit || closesDuringFollowUp || closeAt === "never");
    expect(followUpCommitted).toBe(false);
    if (closesDuringFollowUp) {
      expect(mocks.patchSessionEntryTarget).toHaveBeenCalledOnce();
    }
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    if (closeAt === "never") {
      expect(mockCallArg(respond)).toBe(true);
    } else if (closeAt === "reset fails") {
      expectRespondError(respond, { message: "reset storage unavailable" });
      expect(context.dedupe.get(`agent:${resetRunId}`)).toBeUndefined();
    } else {
      expectRespondError(respond, { message: "agent runtime authority is no longer active" });
      expect(respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
    }
    if (closesAfterCommit || closesDuringFollowUp) {
      authorityActive = true;
      const retry = await reset(message, { client, context });
      expect(mocks.performGatewaySessionReset).toHaveBeenCalledOnce();
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect([mockCallArg(retry), mockCallArg(retry, 0, 3)]).toEqual([true, { cached: true }]);
      expect(mockCallArg(retry, 0, 1)).toMatchObject({
        status: "ok",
        result: {
          meta: { agentMeta: { sessionId } },
          ...(hasFollowUp
            ? { payloads: [{ text: expect.stringContaining("before the follow-up ran") }] }
            : {}),
        },
      });
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
