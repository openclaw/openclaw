import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { claimAgentRunContext } from "../infra/agent-run-registry.js";
import { getRpcSourceIdentity } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { waitForChatAbortTerminalPersistence } from "./chat-abort-lifecycle-internal.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import type { createSubscriptionTestFixture } from "./server-runtime-subscriptions.test-support.js";
import { registerSubscriptionChatRun } from "./server-runtime-subscriptions.test-support.js";

export function registerTerminalReservationPublicationTests(fixture: {
  createParams: ReturnType<typeof createSubscriptionTestFixture>["createParams"];
  start: typeof startGatewayEventSubscriptions;
  installHandlerFactory: (
    factory: typeof import("./server-chat.js").createAgentEventHandler,
  ) => void;
}): void {
  const { createParams, start } = fixture;
  it("persists a queued run start before its deferred chat mapping is registered", async () => {
    const actual = await vi.importActual<typeof import("./server-chat.js")>("./server-chat.js");
    const { persistGatewaySessionLifecycleEvent } = await import("./session-lifecycle-state.js");
    fixture.installHandlerFactory(actual.createAgentEventHandler);
    const params = createParams();
    const runId = "queued-start-run";
    const sessionKey = "agent:main:queued-start";
    const sessionId = "queued-start-session";
    registerSubscriptionChatRun(params, { runId, sessionKey, sessionId });
    claimAgentRunContext(runId, { sessionKey, sessionId });
    const subscriptions = start(params);
    try {
      emitAgentEvent({
        runId,
        sessionKey,
        sessionId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      // Runtime start precedes the queued source's onAgentRunStart callback.
      params.chatRunState.registry.add(runId, { sessionKey, clientRunId: runId });
      await subscriptions.agentUnsub();
      expect(persistGatewaySessionLifecycleEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionKey,
          event: expect.objectContaining({ runId, data: { phase: "start", startedAt: 1_000 } }),
        }),
      );
    } finally {
      await subscriptions.agentUnsub();
      subscriptions.transcriptUnsub();
      subscriptions.lifecycleUnsub();
    }
  });

  it("keeps a newer terminal reservation when an older no-write dispatch fails", async () => {
    const params = createParams();
    const runId = "replaced-terminal-dispatch";
    const registration = registerSubscriptionChatRun(params, {
      runId,
      sessionId: "replaced-terminal-session",
      sessionKey: "agent:main:main",
    });
    const entry = registration.entry;
    claimAgentRunContext(runId, {
      sessionId: getRpcSourceIdentity(entry).sessionId,
      sessionKey: getRpcSourceIdentity(entry).sessionKey,
      projectSessionLifecycle: false,
    });
    const olderDispatch = { entered: createDeferred(), release: createDeferred() };
    const newerDispatch = { entered: createDeferred(), release: createDeferred() };
    const dispatches = [olderDispatch, newerDispatch];
    const failure = new Error("terminal dispatch failed");
    fixture.installHandlerFactory(() =>
      Object.assign(
        async () => {
          const dispatch = dispatches.shift();
          if (!dispatch) {
            throw new Error("Unexpected terminal dispatch");
          }
          dispatch.entered.resolve();
          await dispatch.release.promise;
          throw failure;
        },
        { retireTranscript: vi.fn(), dispose: vi.fn(async () => {}) },
      ),
    );
    start(params);
    const emitTerminal = () =>
      emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", endedAt: 2_000 } });
    let older: Promise<void> | undefined;
    let newer: Promise<void> | undefined;
    try {
      emitTerminal();
      older = waitForChatAbortTerminalPersistence(entry);
      const olderRejected = expect(older).rejects.toBe(failure);
      await olderDispatch.entered.promise;
      emitTerminal();
      newer = waitForChatAbortTerminalPersistence(entry);
      const newerRejected = expect(newer).rejects.toBe(failure);
      await newerDispatch.entered.promise;
      registration.cleanup();
      olderDispatch.release.resolve();
      await olderRejected;
      expect(entry.adapter.projectSessionTerminalPending).toBe(true);
      expect(rpcSourceTesting.get(runId)).toBe(entry);
      newerDispatch.release.resolve();
      await newerRejected;
      expect(entry.adapter.projectSessionTerminalPending).toBe(false);
      expect(rpcSourceTesting.size).toBe(0);
    } finally {
      olderDispatch.release.resolve();
      newerDispatch.release.resolve();
      await Promise.allSettled([older, newer]);
      rpcSourceTesting.deleteExpected(runId, entry);
    }
  });
}
