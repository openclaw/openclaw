import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AcpRunTurnInput } from "../../acp/control-plane/manager.types.js";
import {
  bindIngressLifecycleToReplyOptions,
  type ChannelIngressDispatchLifecycle,
} from "../../channels/message/ingress-drain-lifecycle.js";
import { createChannelIngressDrain } from "../../channels/message/ingress-drain.js";
import {
  createTestIngressQueue,
  withTempState,
} from "../../channels/message/ingress-drain.test-helpers.js";
import {
  acpManagerRuntimeMocks,
  acpMocks,
  createDispatcher,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticDirectReplyConfig,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-support.js";
import { resetInboundDedupe } from "./inbound-dedupe.js";
import { testing as replyRunTesting } from "./reply-run-registry.test-support.js";
import { buildTestCtx } from "./test-ctx.js";

const ADOPTION_TIMEOUT_MS = 300_000;

beforeAll(globalBeforeAll0);
beforeEach(() => {
  describe0BeforeEach0();
  setNoAbort();
  vi.useFakeTimers();
});
afterEach(() => {
  replyRunTesting.resetReplyRunRegistry();
  resetInboundDedupe();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function createAcpIngressFixture(
  stateDir: string,
  runTurn: (input: AcpRunTurnInput) => Promise<void>,
  abortSignal?: AbortSignal,
) {
  const sessionKey = "agent:claude-acp:backend-review";
  const eventId = "backend-review-message";
  const queue = createTestIngressQueue(stateDir);
  await queue.enqueue(eventId, { text: "Review the backend changes" }, { laneKey: sessionKey });
  acpMocks.readAcpSessionEntry.mockReturnValue({
    sessionKey,
    storeSessionKey: sessionKey,
    storePath: "/tmp/mock-sessions.json",
    entry: {},
    acp: {
      backend: "acpx",
      agent: "claude",
      runtimeSessionName: "runtime:backend-review",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    },
  });
  // Keep the harness's session resolution and observability; stub only execution.
  Object.assign(acpManagerRuntimeMocks.getAcpSessionManager(), { runTurn });
  const dispatcher = createDispatcher();
  const replyResolver = vi.fn();
  const dispatches: Promise<unknown>[] = [];
  const dispatchClaimedEvent = vi.fn(
    (_event: unknown, lifecycle: ChannelIngressDispatchLifecycle) => {
      const dispatch = dispatchReplyFromConfig({
        ctx: buildTestCtx({
          Provider: "discord",
          Surface: "discord",
          ChatType: "direct",
          SessionKey: sessionKey,
          MessageSid: eventId,
          BodyForAgent: "Review the backend changes",
        }),
        cfg: {
          ...automaticDirectReplyConfig,
          acp: { enabled: true, dispatch: { enabled: true } },
          agents: { defaults: { timeoutSeconds: 7_200 } },
          session: { sendPolicy: { default: "allow" } },
        },
        dispatcher,
        replyOptions: { ...bindIngressLifecycleToReplyOptions(lifecycle), abortSignal },
        replyResolver,
      });
      dispatches.push(dispatch);
      return dispatch.then(() => undefined);
    },
  );
  const drain = createChannelIngressDrain({
    queue,
    adoptionStallTimeoutMs: ADOPTION_TIMEOUT_MS,
    retryPolicy: { baseMs: 1, maxMs: 1 },
    dispatchClaimedEvent,
  });
  return { queue, drain, eventId, dispatcher, replyResolver, dispatchClaimedEvent, dispatches };
}

describe("ACP reply dispatch durable ingress adoption", () => {
  it("lets an adopted backend review exceed five minutes without replaying the message", async () => {
    await withTempState(async (stateDir) => {
      const releaseTool = createDeferred();
      const submitted = createDeferred();
      const backendSubmitted = vi.fn();
      let turnSignal: AbortSignal | undefined;
      const runTurn = vi.fn(async (input: AcpRunTurnInput) => {
        await input.onBeforePrompt?.();
        turnSignal = input.signal;
        backendSubmitted();
        submitted.resolve();
        await releaseTool.promise;
        await input.onEvent?.({ type: "text_delta", text: "Backend review complete" });
        await input.onEvent?.({ type: "done", status: "completed" });
      });
      const fixture = await createAcpIngressFixture(stateDir, runTurn);
      try {
        await fixture.drain.drainOnce();
        await submitted.promise;
        expect(backendSubmitted).toHaveBeenCalledOnce();
        expect(await fixture.queue.listClaims()).toEqual([]);
        expect((await fixture.queue.enqueue(fixture.eventId, { text: "redelivery" })).kind).toBe(
          "completed",
        );

        await vi.advanceTimersByTimeAsync(ADOPTION_TIMEOUT_MS + 60_000);
        expect(turnSignal?.aborted).toBe(false);
        expect(await fixture.queue.listPending()).toEqual([]);
        expect(await fixture.drain.drainOnce()).toEqual({ started: 0 });
        expect(fixture.dispatchClaimedEvent).toHaveBeenCalledOnce();
        expect(runTurn).toHaveBeenCalledOnce();
        expect(fixture.replyResolver).not.toHaveBeenCalled();

        releaseTool.resolve();
        await Promise.all(fixture.dispatches);
        fixture.dispatcher.markComplete();
        await fixture.dispatcher.waitForIdle();
        expect(fixture.dispatcher.sendFinalReply).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Backend review complete" }),
        );
      } finally {
        releaseTool.resolve();
        await Promise.allSettled(fixture.dispatches);
        fixture.drain.dispose();
      }
    });
  });

  it("still propagates explicit caller cancellation after adoption", async () => {
    await withTempState(async (stateDir) => {
      const caller = new AbortController();
      const releaseTool = createDeferred();
      const submitted = createDeferred();
      const backendSubmitted = vi.fn();
      const cancelled = vi.fn();
      const runTurn = vi.fn(async (input: AcpRunTurnInput) => {
        await input.onBeforePrompt?.();
        input.signal?.addEventListener("abort", cancelled, { once: true });
        backendSubmitted();
        submitted.resolve();
        await releaseTool.promise;
        await input.onEvent?.({ type: "done", status: "cancelled" });
      });
      const fixture = await createAcpIngressFixture(stateDir, runTurn, caller.signal);
      try {
        await fixture.drain.drainOnce();
        await submitted.promise;
        expect(backendSubmitted).toHaveBeenCalledOnce();
        expect(await fixture.queue.listClaims()).toEqual([]);
        caller.abort();
        expect(cancelled).toHaveBeenCalledOnce();
        releaseTool.resolve();
        await Promise.all(fixture.dispatches);
        fixture.dispatcher.markComplete();
        await fixture.dispatcher.waitForIdle();
        expect((await fixture.queue.enqueue(fixture.eventId, { text: "redelivery" })).kind).toBe(
          "completed",
        );
        expect(fixture.dispatcher.sendBlockReply).not.toHaveBeenCalled();
      } finally {
        caller.abort();
        releaseTool.resolve();
        await Promise.allSettled(fixture.dispatches);
        fixture.drain.dispose();
      }
    });
  });

  it("does not submit backend work when startup outlives the ingress claim", async () => {
    await withTempState(async (stateDir) => {
      const releaseStartup = createDeferred();
      const startupReady = createDeferred();
      const startupEntered = vi.fn();
      const backendSubmitted = vi.fn();
      let admissionError: unknown;
      const runTurn = vi.fn(async (input: AcpRunTurnInput) => {
        startupEntered();
        startupReady.resolve();
        await releaseStartup.promise;
        try {
          await input.onBeforePrompt?.();
        } catch (error) {
          admissionError = error;
          throw error;
        }
        backendSubmitted();
        await input.onEvent?.({ type: "done", status: "completed" });
      });
      const fixture = await createAcpIngressFixture(stateDir, runTurn);
      try {
        await fixture.drain.drainOnce();
        await startupReady.promise;
        expect(startupEntered).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(ADOPTION_TIMEOUT_MS + 1);
        expect(await fixture.queue.listPending()).toMatchObject([
          { id: fixture.eventId, attempts: 1 },
        ]);
        releaseStartup.resolve();
        await Promise.all(fixture.dispatches);
        fixture.dispatcher.markComplete();
        await fixture.dispatcher.waitForIdle();
        expect(admissionError).toMatchObject({
          message: expect.stringContaining("claim→adoption stalled"),
        });
        expect(backendSubmitted).not.toHaveBeenCalled();
        expect(runTurn).toHaveBeenCalledOnce();
        expect(fixture.replyResolver).not.toHaveBeenCalled();
      } finally {
        releaseStartup.resolve();
        await Promise.allSettled(fixture.dispatches);
        fixture.drain.dispose();
      }
    });
  });
});
