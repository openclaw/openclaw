import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import * as inbound from "../auto-reply/dispatch.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { GatewayIngressPrincipalBindingV1 } from "../plugins/gateway-ingress.types.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import * as inputMedia from "../sessions/user-turn-transcript-media.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

const sessionKey = "agent:main:dashboard:close-queued-input";
const sessionId = "close-queued-input-session";
const runId = "close-queued-input-retry";
const message = "Keep this accepted follow-up across the Gateway restart.";
const request = { sessionKey, sessionId, message, idempotencyKey: runId, queueMode: "followup" };
type ReplyOptions = NonNullable<
  Parameters<typeof inbound.dispatchInboundMessageWithProjectedDispatcher>[0]["replyOptions"]
>;

async function createQueuedInputCloseFixture() {
  const gateway = await createGatewayMetadataCloseFixture("gateway-close-queued-inputs");
  const port = await gateway.reservePort();
  const server = await gateway.start(port);
  const kernel = gateway.kernels.get(port);
  assert(kernel);
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main", env: gateway.state.env }),
  };
  await upsertSessionEntryCore(scope, {
    sessionId,
    updatedAt: Date.now(),
    createdActor: { type: "human", source: "profile", id: "gateway-owner" },
  });
  await appendTranscriptMessage(scope, {
    message: { role: "user", content: "Existing active task.", timestamp: Date.now() },
  });
  // A synthetic active reply disables injection. The real RPC owns the new
  // input's admission, staging, cancellation, cleanup and database retirement;
  // the dispatch stand-in below does not implement the follow-up queue.
  const active = createReplyOperation({ ...scope, resetTriggered: false });
  active.attachBackend({
    kind: "embedded",
    runId: "existing-close-task",
    cancel: () => {},
    messageInjection: { isAvailable: () => false, queueMessage: vi.fn() },
  });
  bindGatewayContextResolver(active, kernel.resolvePluginGatewayContext);
  const host = getGatewayControlUiIngressHost(kernel.resolvePluginGatewayContext);
  assert(host);
  const service = new AbortController();
  const bindings: GatewayIngressPrincipalBindingV1[] = [];
  const factory = createGatewayControlUiIngressFactory({
    pluginId: "queued-input-close-fixture",
    signal: service.signal,
    assertCurrent: () => service.signal.throwIfAborted(),
    host,
  });
  const bind = async (assertCurrent = () => {}) => {
    const grant = new AbortController();
    const binding = await factory.bindPrincipal({
      audienceId: "queued-input-close-owner",
      principal: { kind: "owner" },
      operatorScopeCeiling: ["operator.admin"],
      signal: grant.signal,
      assertCurrent,
    });
    bindings.push(binding);
    return binding;
  };
  return {
    gateway,
    port,
    server,
    kernel,
    scope,
    active,
    host,
    bind,
    async cleanup() {
      active.complete();
      for (const binding of bindings) {
        await binding.close();
      }
      service.abort();
      await gateway.cleanup();
    },
  };
}

function holdInputStage() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const stage = inputMedia.stageUserTurnPendingInput;
  const spy = vi.spyOn(inputMedia, "stageUserTurnPendingInput").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return stage(...args);
  });
  return { entered, release, spy };
}

function holdRecoveryCapture(
  kernel: Awaited<ReturnType<typeof createQueuedInputCloseFixture>>["kernel"],
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const capture = kernel.shutdownRuntime.markRestartAbortedMainSessions;
  const spy = vi.spyOn(kernel.shutdownRuntime, "markRestartAbortedMainSessions").mockImplementation(
    async (...args) => {
      entered.resolve();
      await release.promise;
      return capture(...args);
    },
  );
  return { entered, release, spy };
}

// Read the closed database before a history API can reconcile an orphaned
// 'queued' row to 'interrupted'. Otherwise the read itself could hide a broken
// close settlement. The real server.close() has joined its database owners.
function readClosedInput(storePath: string) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT state, message_json, consumed_event_id FROM session_pending_inputs
         WHERE session_key = ? AND session_id = ? AND run_id = ?`,
      )
      .all(sessionKey, sessionId, runId);
  } finally {
    db.close();
  }
}

it.for(["restart", "stop"] as const)(
  "settles durably ACKed non-main input as %s requires before real database close",
  async (mode, { signal }) => {
    const fixture = await createQueuedInputCloseFixture();
    const stage = holdInputStage();
    const capture = holdRecoveryCapture(fixture.kernel);
    const dispatched = createDeferredCore<ReplyOptions>();
    const releaseDispatch = createDeferredCore();
    let closing: Promise<void> | undefined;
    let sending: Promise<unknown> | undefined;
    const dispatch = vi.spyOn(inbound, "dispatchInboundMessageWithProjectedDispatcher").mockImplementation(
      async ({ replyOptions }) => {
        assert(replyOptions);
        dispatched.resolve(replyOptions);
        await releaseDispatch.promise;
        replyOptions.abortSignal?.throwIfAborted();
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );
    try {
      const binding = await fixture.bind();
      let acked = false;
      sending = binding.request("chat.send", request).then((ack) => {
        acked = true;
        return ack;
      });
      await withinTest(
        awaitGateBeforeSettlement(stage.entered.promise, sending, "chat.send skipped durable staging"),
        signal,
      );
      expect(acked).toBe(false);
      expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
      stage.release.resolve();
      expect(await withinTest(sending, signal)).toMatchObject({ runId, status: "started" });
      const options = await withinTest(dispatched.promise, signal);
      assert(options.abortSignal);
      expect(await listSessionPendingInputs(fixture.scope)).toMatchObject({
        total: 1,
        items: [{ state: "queued", runId, message: { role: "user", content: message } }],
      });
      closing = fixture.server.close({
        reason: "queued input close regression",
        ...(mode === "restart" ? { restartExpectedMs: 0, drainTimeoutMs: 0 } : {}),
      });
      if (mode === "restart") {
        await withinTest(
          awaitGateBeforeSettlement(capture.entered.promise, closing, "close skipped recovery capture"),
          signal,
        );
        // New intake is fenced, but accepted principal and execution authority
        // must remain live until capture has settled.
        expect(fixture.kernel.requestEntryLifetime.signal.aborted).toBe(true);
        expect(fixture.host.signal.aborted).toBe(false);
        expect(options.abortSignal?.aborted).toBe(false);
        await expect(
          binding.request("chat.send", { ...request, idempotencyKey: "too-late" }),
        ).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: true });
        capture.release.resolve();
      }
      const aborted = createDeferredCore();
      if (options.abortSignal?.aborted) {
        aborted.resolve();
      } else {
        options.abortSignal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      }
      await withinTest(
        awaitGateBeforeSettlement(
          aborted.promise,
          closing,
          "close skipped accepted input cancellation",
        ),
        signal,
      );
      expect(isAgentRunRestartAbortReason(options.abortSignal?.reason)).toBe(mode === "restart");
      releaseDispatch.resolve();
      fixture.active.complete();
      await withinTest(closing, signal);
      expect(readClosedInput(fixture.scope.storePath)).toEqual([
        {
          state: mode === "restart" ? "interrupted" : "cancelled",
          message_json: expect.stringContaining(message),
          consumed_event_id: null,
        },
      ]);
      if (mode === "stop") {
        expect(capture.spy).not.toHaveBeenCalled();
        return;
      }

      // Reopen the same store and endpoint; no generic non-main replay is
      // expected. Only a newly authorized same-key request may reclaim it.
      capture.spy.mockRestore();
      stage.spy.mockRestore();
      dispatch.mockClear();
      const reopened = await fixture.gateway.start(fixture.port);
      const next = fixture.gateway.kernels.get(fixture.port);
      assert(next);
      const nextHost = getGatewayControlUiIngressHost(next.resolvePluginGatewayContext);
      assert(nextHost);
      const nextService = new AbortController();
      const nextFactory = createGatewayControlUiIngressFactory({
        pluginId: "queued-input-close-fixture",
        signal: nextService.signal,
        assertCurrent: () => nextService.signal.throwIfAborted(),
        host: nextHost,
      });
      const nextGrant = new AbortController();
      const retry = await nextFactory.bindPrincipal({
        audienceId: "queued-input-close-owner",
        principal: { kind: "owner" },
        operatorScopeCeiling: ["operator.admin"],
        signal: nextGrant.signal,
        assertCurrent: () => nextGrant.signal.throwIfAborted(),
      });
      const consumed = createDeferredCore();
      dispatch.mockImplementation(async ({ replyOptions }) => {
        assert(replyOptions?.userTurnTranscriptRecorder);
        await replyOptions.userTurnTranscriptRecorder.persistApproved();
        consumed.resolve();
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      });
      try {
        expect(dispatch).not.toHaveBeenCalled();
        expect(await retry.request("chat.send", request)).toMatchObject({ runId });
        await withinTest(consumed.promise, signal);
        await withinTest(
          Promise.resolve(
            getSessionWorkAdmissionRelease({
              scope: fixture.scope.storePath,
              identities: [sessionKey, sessionId],
            }),
          ),
          signal,
        );
        expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
        next.gatewayRequestContext.dedupe.clear();
        // A reconnect retry after consumption must return the durable receipt,
        // not invoke the model boundary a second time.
        expect(await retry.request("chat.send", request)).toMatchObject({ runId });
        expect(dispatch).toHaveBeenCalledOnce();
      } finally {
        await retry.close();
        nextService.abort();
        await reopened.close();
      }
      expect(readClosedInput(fixture.scope.storePath)).toEqual([
        expect.objectContaining({ consumed_event_id: expect.any(String) }),
      ]);
    } finally {
      stage.release.resolve();
      capture.release.resolve();
      releaseDispatch.resolve();
      fixture.active.complete();
      await Promise.allSettled([sending, closing]);
      // Restore only these spies: the shared Gateway fixture owns its own spies.
      stage.spy.mockRestore();
      capture.spy.mockRestore();
      dispatch.mockRestore();
      await fixture.cleanup();
    }
  },
);

it("rejects an uncommitted ingress input when its grant is revoked during restart capture", async ({ signal }) => {
  const fixture = await createQueuedInputCloseFixture();
  const stage = holdInputStage();
  const capture = holdRecoveryCapture(fixture.kernel);
  const dispatch = vi.spyOn(inbound, "dispatchInboundMessageWithProjectedDispatcher");
  let current = true;
  let revocationChecks = 0;
  let closing: Promise<void> | undefined;
  let outcome: Promise<unknown> | undefined;
  try {
    const binding = await fixture.bind(() => {
      if (!current) {
        revocationChecks += 1;
        throw new Error("queued-input fixture grant revoked");
      }
    });
    const sending = binding.request("chat.send", request);
    // Attach rejection handling before revoking the grant.
    outcome = sending.catch((error: unknown) => error);
    await withinTest(
      awaitGateBeforeSettlement(stage.entered.promise, sending, "chat.send skipped staging"),
      signal,
    );
    closing = fixture.server.close({ restartExpectedMs: 0, drainTimeoutMs: 0 });
    await withinTest(
      awaitGateBeforeSettlement(capture.entered.promise, closing, "close skipped recovery capture"),
      signal,
    );
    expect(fixture.host.signal.aborted).toBe(false);
    // Deliberately leave the signal live: the current grant assertion, not
    // merely an AbortSignal, must still guard the write after its await.
    current = false;
    stage.release.resolve();
    expect(await withinTest(outcome, signal)).toBeInstanceOf(Error);
    expect(revocationChecks).toBeGreaterThan(0);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await listSessionPendingInputs(fixture.scope)).toEqual({ items: [], total: 0 });
    capture.release.resolve();
    fixture.active.complete();
    await withinTest(closing, signal);
    expect(readClosedInput(fixture.scope.storePath)).toEqual([]);
  } finally {
    stage.release.resolve();
    capture.release.resolve();
    fixture.active.complete();
    await Promise.allSettled([outcome, closing]);
    stage.spy.mockRestore();
    capture.spy.mockRestore();
    dispatch.mockRestore();
    await fixture.cleanup();
  }
});
