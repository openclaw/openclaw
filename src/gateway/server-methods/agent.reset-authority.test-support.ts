// Register in the existing suite so test names, ordering, and cleanup stay unchanged.
import { expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createAgentDedupeLifecycle } from "../agent-turn/agent-dedupe-lifecycle.js";
import {
  type getAgentTestMocks,
  operatorWriteCliClient,
  makeContext,
  requireValue,
  mockCallArg,
  expectRespondError,
  expectRecordFields,
  mockMainSessionEntry,
  invokeAgent,
  mockSessionResetSuccess,
} from "./agent.test-harness.js";

export function registerAgentResetAuthorityTests(mocks: ReturnType<typeof getAgentTestMocks>) {
  it("handles bare /reset by resetting the same session without running the model", async () => {
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    mocks.agentCommand.mockClear();

    const respond = await invokeAgent(
      {
        message: "/reset",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-reset",
      },
      {
        reqId: "4-reset",
        client: operatorWriteCliClient(["operator.admin"]),
      },
    );

    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(mockCallArg(respond)).toBe(true);
    const result = expectRecordFields(mockCallArg(respond, 0, 1), {}).result as {
      payloads?: Array<{ text?: string }>;
    };
    expect(result.payloads?.[0]?.text).toBe("✅ Session reset.");
  });

  it.each([
    "before ingress",
    "before reset commit",
    "after reset commit",
    "after reset commit with follow-up",
    "during follow-up persistence",
    "reset fails",
    "never",
  ] as const)(
    "keeps /reset effects within delegated runtime authority closing %s",
    async (closeAt) => {
      let authorityActive = closeAt !== "before ingress";
      let resetCommitted = false;
      const closesAfterCommit = closeAt.startsWith("after reset commit");
      const closesDuringFollowUp = closeAt === "during follow-up persistence";
      const hasFollowUp = closeAt.endsWith("with follow-up") || closesDuringFollowUp;
      const message = hasFollowUp ? "/reset continue working" : "/reset";
      let followUpCommitted = false;
      // Existing-session resets preserve the session ID and advance the lifecycle.
      // Model that contract in the case that reaches post-reset persistence.
      mockMainSessionEntry({
        sessionId: closesDuringFollowUp ? "reset-session-id" : "existing-session-id",
        ...(closesDuringFollowUp ? { lifecycleRevision: "before-reset" } : {}),
      });
      mocks.performGatewaySessionReset.mockClear();
      mocks.agentCommand.mockClear();
      mocks.patchSessionEntryTarget.mockClear();
      if (closesDuringFollowUp) {
        mocks.patchSessionEntryTarget.mockImplementationOnce(
          async (
            scope,
            _update,
            options: {
              assertCommitAllowed: () => void;
              fallbackEntry?: { sessionId: string; lifecycleRevision?: string };
            },
          ) => {
            expect(scope).toMatchObject({
              agentId: "main",
              target: { canonicalKey: "agent:main:main" },
            });
            expect(options.fallbackEntry).toMatchObject({
              sessionId: "reset-session-id",
              lifecycleRevision: "after-reset",
            });
            expect(resetCommitted).toBe(true);
            expect(authorityActive).toBe(true);
            await Promise.resolve();
            authorityActive = false;
            options.assertCommitAllowed();
            followUpCommitted = true;
            return null;
          },
        );
      }
      mocks.performGatewaySessionReset.mockImplementation(
        async (options: {
          assertCurrent?: () => void;
          onCommitted?: (commit: { key: string; sessionId: string }) => void;
        }) => {
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
          options.onCommitted?.({ key: "agent:main:main", sessionId: "reset-session-id" });
          mockMainSessionEntry({
            sessionId: "reset-session-id",
            ...(closesDuringFollowUp ? { lifecycleRevision: "after-reset" } : {}),
          });
          if (closesAfterCommit) {
            authorityActive = false;
          }
          return {
            ok: true,
            key: "agent:main:main",
            entry: { sessionId: "reset-session-id" },
          };
        },
      );
      const client = operatorWriteCliClient(["operator.admin"]);
      const operationalRunInstance = createOperationalRunInstanceRef("reset-caller");
      client.internal = {
        agentRuntimeIdentity: {
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:main",
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

      const respond = await invokeAgent(
        {
          message,
          sessionKey: "agent:main:main",
          idempotencyKey: "test-idem-reset-closed-authority",
        },
        { reqId: "4-reset-closed-authority", client, context },
      );

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
        expect(context.dedupe.get("agent:test-idem-reset-closed-authority")).toBeUndefined();
      } else {
        expectRespondError(respond, { message: "agent runtime authority is no longer active" });
        expect(respond.mock.calls.some(([ok]) => ok === true)).toBe(false);
      }
      if (closesAfterCommit || closesDuringFollowUp) {
        authorityActive = true;
        const retry = await invokeAgent(
          {
            message,
            sessionKey: "agent:main:main",
            idempotencyKey: "test-idem-reset-closed-authority",
          },
          { client, context },
        );
        expect(mocks.performGatewaySessionReset).toHaveBeenCalledOnce();
        expect(mocks.agentCommand).not.toHaveBeenCalled();
        expect(mockCallArg(retry)).toBe(true);
        expect(mockCallArg(retry, 0, 3)).toEqual({ cached: true });
        expect(mockCallArg(retry, 0, 1)).toMatchObject({
          status: "ok",
          result: { meta: { agentMeta: { sessionId: "reset-session-id" } } },
        });
        if (hasFollowUp) {
          expect(mockCallArg(retry, 0, 1)).toMatchObject({
            result: { payloads: [{ text: expect.stringContaining("before the follow-up ran") }] },
          });
        }
      }
    },
  );

  it.each([
    "owned reservation",
    "stop",
    "newer reservation",
    "newer terminal",
    "accepted run",
    "missing reservation",
    "failed reply",
    "failed reply after rotation",
    "failed reply after stop",
    "failed reply after replacement",
    "failed reply after stop and rotation",
    "failed reply after replacement and rotation",
    "failed reply with replaced alias",
    "failed reply with replaced alias and rotation",
  ] as const)("preserves reset cleanup ownership for %s", (state) => {
    const context = makeContext();
    const runId = "reset-cleanup-ownership";
    const key = `agent:${runId}`;
    const alias = `agent:exec-approval-followup:${runId}`;
    const hasAlias = state.includes("alias");
    const rotates = state.includes("rotation");
    const emit = vi.fn();
    const replyError = state.startsWith("failed reply")
      ? { code: "INVALID_REQUEST", message: "confirmation failed" }
      : undefined;
    const lifecycle = createAgentDedupeLifecycle({
      cfg: {},
      request: { message: "/reset follow up", idempotencyKey: runId },
      runId,
      lifecycleGeneration: mocks.lifecycleGeneration,
      agentDedupeKeys: hasAlias ? [key, alias] : [key],
      suppressVisibleSessionEffects: false,
      context,
      io: { emitAcceptance: emit, emitFinal: emit },
    });
    lifecycle.reserve("agent:main:main", "main");
    const reservation = requireValue(context.dedupe.get(key), "reset reservation missing");
    reservation.requestIdentity = "original-request-fingerprint";
    lifecycle.setCommittedResetCompletion({
      reason: "reset",
      sessionId: "reset-session-id",
      sessionKey: "agent:main:main",
      followUpPending: !replyError,
      replyError,
    });
    if (state === "stop" || state.includes("after stop")) {
      context.dedupe.set(key, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "timeout", stopReason: "rpc" },
      });
    } else if (state === "newer reservation" || state.includes("after replacement")) {
      context.dedupe.set(key, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "accepted", reservationId: "new-owner" },
      });
    } else if (state === "newer terminal") {
      context.dedupe.set(key, { ts: Date.now(), ok: true, payload: { runId, status: "ok" } });
    } else if (state === "accepted run") {
      lifecycle.markAccepted(true);
    } else if (state === "missing reservation") {
      context.dedupe.delete(key);
    }
    if (hasAlias) {
      context.dedupe.set(alias, {
        ts: Date.now(),
        ok: true,
        payload: { runId, status: "accepted", reservationId: "new-alias-owner" },
      });
    }
    const before = context.dedupe.get(key);
    const aliasBefore = context.dedupe.get(alias);
    if (rotates) {
      mocks.lifecycleGeneration = "rotated-reset-reply";
      expect(lifecycle.abortForLifecycleRotation()).toBe(true);
    }
    lifecycle.clearUnaccepted();
    lifecycle.clearUnaccepted();
    if (state === "owned reservation") {
      expect(context.dedupe.get(key)).toMatchObject({
        ok: true,
        requestIdentity: "original-request-fingerprint",
        payload: {
          runId,
          status: "ok",
          result: { meta: { agentMeta: { sessionId: "reset-session-id" } } },
        },
      });
    } else if (state === "failed reply" || state === "failed reply after rotation" || hasAlias) {
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
    if (state === "failed reply after rotation") {
      expect(emit).toHaveBeenCalledExactlyOnceWith([false, undefined, replyError], { runId });
    } else if (rotates) {
      expect(emit).toHaveBeenCalledOnce();
      expect(mockCallArg(emit, 0, 1)).toMatchObject({ cached: true });
      expect(mockCallArg(emit)).toEqual(
        hasAlias
          ? [false, undefined, replyError]
          : [
              true,
              state.includes("after stop")
                ? before?.payload
                : { runId, status: "in_flight", admissionPending: true },
              undefined,
            ],
      );
    } else {
      expect(emit).not.toHaveBeenCalled();
    }
  });
}
