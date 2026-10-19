import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import type { RpcSourceRef } from "../../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../../state/user-profiles-schema.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { agentHandlers } from "../server-methods/agent.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import type { DedupeEntry } from "../server-shared.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { replayAgentTurnIfCached } from "./agent-dedupe.js";
import * as agentJobs from "./agent-job.js";
import { setGatewayDedupeEntry, waitForAgentJob } from "./agent-job.js";
import { createAgentTurnService } from "./agent-turn-service.js";
import { createTestRpcSource, testRpcSourceController } from "./rpc-source.test-support.js";

function waitThroughGateway(
  params: { runId: string; timeoutMs: number },
  activeKind?: "agent" | "chat",
) {
  const respond = vi.fn();
  const handler = expectDefined(
    agentHandlers["agent.wait"],
    'agentHandlers["agent.wait"] test invariant',
  );
  const source = activeKind
    ? createTestRpcSource(
        {
          kind: activeKind === "agent" ? "agent" : "chat-send",
          sessionKey: "agent:main:wait",
          sessionId: "wait-session",
        },
        params.runId,
      )
    : undefined;
  const claim = source ? claimSessionControllerTask(source.input, () => {}) : undefined;
  rpcSourceTesting.reset(source ? [[params.runId, source]] : []);
  const promise = (async () => {
    try {
      return await handler({
        params,
        respond,
        context: { dedupe: new Map() },
      } as unknown as Parameters<typeof handler>[0]);
    } finally {
      if (claim !== undefined) {
        releaseSessionControllerClaim(await claim);
      }
    }
  })();
  return { promise, respond };
}

function completeRun(
  dedupe: Map<string, DedupeEntry>,
  runId: string,
  source: "agent" | "chat" = "agent",
): void {
  setGatewayDedupeEntry({
    dedupe,
    key: `${source}:${runId}`,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: { runId, status: "ok", startedAt: 100, endedAt: 200 },
    },
  });
}

function terminalReceipt(runId: string) {
  return {
    runId,
    sessionId: "session-1",
    turnId: "turn-1",
    requested: { provider: "openai", model: "gpt-primary" },
    effective: { provider: "openai", model: "gpt-alternate", responseModel: "gpt-alternate" },
    successfulToolNames: ["read"],
    rerouted: true,
    terminalDisposition: "visible",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("agent.wait gateway dedupe observations", () => {
  it("keeps whitespace-distinct protocol run IDs separate", async () => {
    const plain = "exact-rpc-id";
    const spaced = " exact-rpc-id ";
    const dedupe = new Map<string, DedupeEntry>();
    completeRun(dedupe, plain);
    const source = createRpcSourceForTest(
      { kind: "agent" },
      {
        runId: spaced,
        sessionKey: "agent:main:exact-rpc",
        sessionId: "exact-session",
        phase: "waiting",
      },
    );
    rpcSourceTesting.reset([[spaced, source]]);
    const service = createAgentTurnService({
      context: { dedupe } as unknown as Parameters<typeof createAgentTurnService>[0]["context"],
      isWebchatConnect: () => false,
    });
    expect((await service.waitForTurn({ runId: spaced, timeoutMs: 0 })).result).toMatchObject({
      runId: spaced,
      status: "pending",
      timeoutPhase: "queue",
    });
    expect((await service.waitForTurn({ runId: plain, timeoutMs: 0 })).result).toMatchObject({
      runId: plain,
      status: "ok",
    });
  });

  it.each(
    (["ok", "error", "timeout"] as const).flatMap((status) =>
      (["active", "retired", "sessionless"] as const).map((registration) => ({
        status,
        registration,
      })),
    ),
  )(
    "waits for replayable $status after execution ends ($registration)",
    async ({ status, registration }) => {
      vi.useFakeTimers();
      const runId = `publication-${status}-${registration}`;
      const key = `agent:${runId}`;
      const context = createGatewayRequestContext(makeContextParams());
      let claim: SessionControllerMailboxClaim | undefined;
      if (registration !== "sessionless") {
        const source = createTestRpcSource(
          {
            kind: "agent",
            sessionKey: "agent:main:publication",
            sessionId: "publication-session",
          },
          runId,
        );
        rpcSourceTesting.set(runId, source);
        claim = await claimSessionControllerTask(source.input, () => {});
      }
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key,
        entry: { ts: Date.now(), ok: true, payload: { runId, status: "accepted" } },
      });
      const handler = expectDefined(agentHandlers["agent.wait"], "registered wait handler");
      const invokeWait = (timeoutMs: number, respond = vi.fn()) => ({
        respond,
        promise: handler({
          req: { type: "req", id: runId, method: "agent.wait" },
          params: { runId, timeoutMs },
          respond,
          context,
          client: null,
          isWebchatConnect: () => false,
        }),
      });
      const replay = () => {
        const emitAcceptance = vi.fn();
        expect(
          replayAgentTurnIfCached({
            preflight: { runId, agentDedupeKeys: [key] },
            context,
            io: { emitAcceptance, emitFinal: vi.fn() },
          }),
        ).toBe(true);
        return emitAcceptance.mock.calls[0]?.[0];
      };
      const terminal = {
        runId,
        status,
        ...(status === "timeout" ? { stopReason: "rpc" } : {}),
        result: { payloads: [{ text: "canonical terminal reply" }] },
      };
      const publish = () =>
        setGatewayDedupeEntry({
          dedupe: context.dedupe,
          key,
          entry: { ts: Date.now(), ok: status !== "error", payload: terminal },
        });
      const waiting = invokeWait(60_000);
      try {
        expect(replay()?.[1]).toMatchObject({ runId, status: "in_flight" });
        emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "start" } });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", executionSettled: true, ...terminal },
        });
        if (registration === "retired") {
          rpcSourceTesting.delete(runId);
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(waiting.respond).not.toHaveBeenCalled();
        const duringPublication = invokeWait(0);
        await duringPublication.promise;
        expect(duringPublication.respond).toHaveBeenCalledWith(true, { runId, status: "timeout" });
        expect(replay()?.[1]).toMatchObject({ runId, status: "in_flight" });
        publish();
        rpcSourceTesting.delete(runId);
        await waiting.promise;
        expect(waiting.respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            runId,
            status: status === "timeout" ? "error" : status,
          }),
        );
        expect(replay()).toEqual([status !== "error", terminal, undefined]);
        const afterCleanup = invokeWait(0);
        await afterCleanup.promise;
        expect(afterCleanup.respond.mock.calls).toEqual(waiting.respond.mock.calls);
      } finally {
        publish();
        await waiting.promise;
        rpcSourceTesting.clear();
        if (claim) {
          releaseSessionControllerClaim(claim);
        }
      }
    },
  );

  it.each([undefined, true] as const)(
    "retires a sticky terminal only for an admitted new attempt: %s",
    async (startNewAttempt) => {
      const runId = `private-retry-${startNewAttempt ?? "ordinary"}`;
      const key = `agent:${runId}`;
      const dedupe = new Map<string, DedupeEntry>();
      setGatewayDedupeEntry({
        dedupe,
        key,
        entry: {
          ts: 100,
          ok: true,
          requestIdentity: "original-input-binding",
          payload: { runId, status: "timeout", stopReason: "restart" },
        },
      });
      setGatewayDedupeEntry({
        dedupe,
        key,
        startNewAttempt: true,
        entry: { ts: 150, ok: true, payload: { runId, status: "ok" } },
      });
      expect(dedupe.get(key)?.payload).toMatchObject({ status: "timeout", stopReason: "restart" });
      setGatewayDedupeEntry({
        dedupe,
        key,
        startNewAttempt,
        entry: {
          ts: 200,
          ok: true,
          requestIdentity: "replacement-must-not-change-binding",
          payload: { runId, status: "accepted", reservationId: "new-admission" },
        },
      });
      expect(dedupe.get(key)?.requestIdentity).toBe("original-input-binding");
      expect(dedupe.get(key)?.payload).toMatchObject({
        status: startNewAttempt ? "accepted" : "timeout",
      });
      const observed = await waitForAgentJob({ runId, timeoutMs: 0 });
      if (startNewAttempt) {
        expect(observed).toBeNull();
        completeRun(dedupe, runId);
        expect(await waitForAgentJob({ runId, timeoutMs: 0 })).toMatchObject({ status: "ok" });
      } else {
        expect(observed).toMatchObject({ status: "error", stopReason: "restart" });
      }
    },
  );

  it("expires terminal observations from their latest write without extending unrelated runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const dedupe = new Map<string, DedupeEntry>();
    completeRun(dedupe, "cache-refreshed");
    completeRun(dedupe, "cache-original");
    vi.setSystemTime(1_000_100);
    completeRun(dedupe, "cache-refreshed");
    // Wall-clock correction can insert an earlier expiry after newer records.
    vi.setSystemTime(999_900);
    completeRun(dedupe, "cache-clock-correction");

    for (const [now, expected] of [
      [1_599_900, ["ok", "ok", "ok"]],
      [1_599_901, ["ok", "ok", "timeout"]],
      [1_600_000, ["ok", "ok", "timeout"]],
      [1_600_001, ["ok", "timeout", "timeout"]],
      [1_600_100, ["ok", "timeout", "timeout"]],
      [1_600_101, ["timeout", "timeout", "timeout"]],
    ] as const) {
      vi.setSystemTime(now);
      const runIds = ["cache-refreshed", "cache-original", "cache-clock-correction"];
      for (const [index, runId] of runIds.entries()) {
        const waiter = waitThroughGateway({ runId, timeoutMs: 0 });
        await waiter.promise;
        expect(waiter.respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId, status: expected[index] }),
        );
      }
    }
  });

  it("keeps visible queued waits available after the terminal observation expires", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg);
      ensureUserProfilesSchema({});
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const owner = roleClient("none", "queued-owner");
      const other = roleClient("none", "queued-other");
      const session = {
        sessionKey: "agent:main:queued-visible",
        sessionId: "queued-visible-session",
        agentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      };
      await upsertSessionEntryCore(
        { agentId: session.agentId, sessionKey: session.sessionKey },
        {
          sessionId: session.sessionId,
          updatedAt: Date.now(),
          visibility: "draft",
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(owner.authenticatedUserProfile, "queued owner profile").profileId,
          },
        },
      );
      const runId = "queued-visible-wait";
      rpcSourceTesting.clear();
      const source = createRpcSourceForTest({}, { ...session, runId, phase: "waiting" });
      const controller = testRpcSourceController(source);
      const handler = expectDefined(agentHandlers["agent.wait"], "registered wait handler");
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = () => cfg;
      const invoke = async (client: typeof owner) => {
        const respond = vi.fn();
        await handler({
          req: { type: "req", id: runId, method: "agent.wait" },
          params: { runId, timeoutMs: 0 },
          respond,
          client,
          isWebchatConnect: () => true,
          context,
        });
        return respond;
      };
      try {
        vi.useFakeTimers();
        vi.setSystemTime(2_000_000);
        rpcSourceTesting.set(runId, source);
        setGatewayDedupeEntry({
          dedupe: new Map(),
          key: `chat:${runId}`,
          session,
          entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
        });
        const expected = {
          runId,
          status: "pending",
          timeoutPhase: "queue",
          providerStarted: false,
        };
        expect(await invoke(owner)).toHaveBeenCalledWith(true, expected);
        vi.setSystemTime(2_600_001);
        expect(await invoke(owner)).toHaveBeenCalledWith(true, expected);
        expect(await invoke(other)).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ message: "agent run was not found" }),
        );
      } finally {
        controller.abort();
        vi.useRealTimers();
      }
    });
  });

  it.each(["compaction", "replacement"] as const)(
    "keeps a pending wait bound to its original registration after %s",
    async (transition) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const cfg = rolePolicyConfig();
        setRuntimeConfigSnapshot(cfg);
        ensureUserProfilesSchema({});
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const owner = roleClient("none", "timeout-owner");
        const session = {
          sessionKey: "agent:main:timeout-rotation",
          sessionId: "original-session",
          agentId: "main",
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        };
        const target = { agentId: session.agentId, sessionKey: session.sessionKey };
        await upsertSessionEntryCore(target, {
          sessionId: session.sessionId,
          updatedAt: Date.now(),
          visibility: "draft",
          createdActor: {
            type: "human",
            source: "profile",
            id: expectDefined(owner.authenticatedUserProfile, "wait owner profile").profileId,
          },
        });
        const runId = `wait-timeout-${transition}`;
        registerAgentRunContext(runId, session);
        const context = createGatewayRequestContext(makeContextParams());
        context.getRuntimeConfig = () => cfg;
        const respond = vi.fn();
        const handler = expectDefined(agentHandlers["agent.wait"], "registered wait handler");
        const started = createDeferredCore();
        const wait = agentJobs.waitForAgentJob;
        vi.spyOn(agentJobs, "waitForAgentJob").mockImplementationOnce((params) => {
          const pending = wait(params);
          started.resolve();
          return pending;
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const waiting = handler({
          req: { type: "req", id: runId, method: "agent.wait" },
          params: { runId, timeoutMs: 10 },
          respond,
          client: owner,
          isWebchatConnect: () => true,
          context,
        });
        try {
          await started.promise;
          expect(respond).not.toHaveBeenCalled();
          await upsertSessionEntryCore(target, { sessionId: "successor-session" });
          if (transition === "replacement") {
            clearAgentRunContext(runId);
          }
          registerAgentRunContext(runId, { ...session, sessionId: "successor-session" });
          await vi.advanceTimersByTimeAsync(10);
          await waiting;
          if (transition === "compaction") {
            expect(respond).toHaveBeenCalledWith(true, { runId, status: "timeout" });
          } else {
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({ message: "agent run was not found" }),
            );
          }
        } finally {
          await vi.advanceTimersByTimeAsync(10);
          await waiting;
          clearAgentRunContext(runId);
          vi.useRealTimers();
        }
      });
    },
  );

  it.each([
    ["agent", "timeout"],
    ["chat", "ok"],
  ] as const)("uses the %s abort entry to select the run observation", async (kind, status) => {
    const runId = `run-kind-${kind}`;
    const dedupe = new Map<string, DedupeEntry>();
    setGatewayDedupeEntry({
      dedupe,
      key: `agent:${runId}`,
      entry: {
        ts: 100,
        ok: false,
        payload: { runId, status: "timeout", endedAt: 100, timeoutPhase: "provider" },
      },
    });
    setGatewayDedupeEntry({
      dedupe,
      key: `chat:${runId}`,
      entry: { ts: 200, ok: true, payload: { runId, status: "ok", endedAt: 200 } },
    });

    const waiter = waitThroughGateway({ runId, timeoutMs: 0 }, kind);
    await waiter.promise;
    expect(waiter.respond).toHaveBeenCalledWith(true, expect.objectContaining({ runId, status }));
  });

  it("binds queued observation to the queue entry selected after waiting", async () => {
    const runId = "queued-observation-session";
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const original = {
      sessionKey: "agent:main:original",
      sessionId: "original-session",
      agentId: "main",
      lifecycleGeneration,
    };
    setGatewayDedupeEntry({
      dedupe: new Map(),
      key: `agent:${runId}`,
      session: original,
      entry: { ts: Date.now(), ok: true, payload: { runId, status: "ok" } },
    });
    rpcSourceTesting.clear();
    const service = createAgentTurnService({
      context: {
        dedupe: new Map(),
      } as unknown as Parameters<typeof createAgentTurnService>[0]["context"],
      isWebchatConnect: () => false,
    });
    const selected = service.waitForTurn({ runId, timeoutMs: 0 });
    const queued = {
      sessionKey: "agent:main:queued",
      sessionId: "queued-session",
      agentId: "main",
    };
    const source = createRpcSourceForTest({}, { ...queued, runId, phase: "waiting" });
    const controller = testRpcSourceController(source);
    try {
      rpcSourceTesting.set(runId, source);
      await expect(selected).resolves.toEqual({
        session: { ...queued, lifecycleGeneration },
        result: { runId, status: "pending", timeoutPhase: "queue", providerStarted: false },
      });
    } finally {
      controller.abort();
      await selected;
    }
  });

  it("observes later queue admission without completing terminal or another Gateway's waits", async () => {
    vi.useFakeTimers();
    const runId = "queued-after-wait";
    const context = createGatewayRequestContext(makeContextParams());
    const otherContext = createGatewayRequestContext(makeContextParams());
    context.resolveGatewayContext = () => context;
    otherContext.resolveGatewayContext = () => otherContext;
    const service = createAgentTurnService({ context, isWebchatConnect: () => false });
    const otherService = createAgentTurnService({
      context: otherContext,
      isWebchatConnect: () => false,
    });
    const queuedObserved = vi.fn();
    const terminalObserved = vi.fn();
    const otherObserved = vi.fn();
    const queuedWait = service.waitForTurn({ runId, timeoutMs: 30_000 }).then(queuedObserved);
    const terminalWait = waitForAgentJob({ runId, timeoutMs: 30_000, source: "chat" }).then(
      terminalObserved,
    );
    const otherWait = otherService.waitForTurn({ runId, timeoutMs: 30_000 }).then(otherObserved);
    let queuedSource: RpcSourceRef | undefined;
    const session = {
      sessionKey: "agent:main:queued-after-wait",
      sessionId: "queued-after-wait-session",
      agentId: "main",
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
    };
    try {
      queuedSource = createRpcSourceForTest(
        { kind: "chat-send" },
        {
          runId,
          ...session,
          phase: "waiting",
        },
      );
      bindGatewayContextResolver(queuedSource.input, context.resolveGatewayContext);
      rpcSourceTesting.set(runId, queuedSource);
      setGatewayDedupeEntry({
        dedupe: context.dedupe,
        key: `chat:${runId}`,
        session,
        entry: { ts: Date.now(), ok: true, payload: { runId, status: "accepted" } },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(queuedObserved).toHaveBeenCalledWith({
        session,
        result: { runId, status: "pending", timeoutPhase: "queue", providerStarted: false },
      });
      expect(terminalObserved).not.toHaveBeenCalled();
      expect(otherObserved).not.toHaveBeenCalled();
    } finally {
      if (queuedSource) {
        testRpcSourceController(queuedSource).abort();
      }
      completeRun(context.dedupe, runId, "chat");
      await Promise.all([queuedWait, terminalWait, otherWait]);
    }
  });

  it.each([undefined, "agent", "chat"] as const)(
    "resolves concurrent %s waiters when the terminal dedupe entry lands",
    async (source) => {
      const runId = `run-public-concurrent-waiters-${source ?? "untracked"}`;
      const dedupe = new Map<string, DedupeEntry>();
      const first = waitThroughGateway({ runId, timeoutMs: 1_000 }, source);
      const second = waitThroughGateway({ runId, timeoutMs: 1_000 }, source);

      await Promise.resolve();
      completeRun(dedupe, runId, source ?? "agent");
      await Promise.all([first.promise, second.promise]);

      const expected = {
        runId,
        status: "ok",
        startedAt: 100,
        endedAt: 200,
        error: undefined,
        stopReason: undefined,
        livenessState: undefined,
        yielded: undefined,
        pendingError: undefined,
        timeoutPhase: undefined,
        providerStarted: undefined,
      };
      expect(first.respond).toHaveBeenCalledWith(true, expected);
      expect(second.respond).toHaveBeenCalledWith(true, expected);
    },
  );

  it("retires only its scope's observer without ending the shared run", async () => {
    const runId = "run-scope-observers";
    const dedupe = new Map<string, DedupeEntry>();
    const first = new AsyncWorkScope();
    const second = new AsyncWorkScope();
    let firstSettled = false;
    let secondSettled = false;
    const firstWait = first
      .track(() => waitForAgentJob({ runId, timeoutMs: 600_000 }))
      .then((result) => {
        firstSettled = true;
        return result;
      });
    const secondWait = second
      .track(() => waitForAgentJob({ runId, timeoutMs: 600_000 }))
      .then((result) => {
        secondSettled = true;
        return result;
      });
    try {
      first.beginClose();
      await nextTurn();
      expect(firstSettled).toBe(true);
      expect(secondSettled).toBe(false);
      expect(await firstWait).toBeNull();
      completeRun(dedupe, runId);
      await expect(secondWait).resolves.toMatchObject({ status: "ok", endedAt: 200 });
      await expect(waitForAgentJob({ runId, timeoutMs: 0 })).resolves.toMatchObject({
        status: "ok",
        endedAt: 200,
      });
    } finally {
      // The old owner has no shutdown observer: release it without waiting ten minutes.
      if (!firstSettled || !secondSettled) {
        completeRun(dedupe, runId);
      }
      await Promise.all([firstWait, secondWait, first.drain(), second.drain()]);
    }
  });

  it.each([
    { activeKind: undefined, timeoutMs: 0, reset: false },
    { activeKind: "agent", timeoutMs: 10, reset: false },
    { activeKind: "chat", timeoutMs: 10, reset: false },
    { activeKind: undefined, timeoutMs: 1_000, reset: true },
  ] as const)(
    "keeps $activeKind observation interruption nonterminal (timeout=$timeoutMs, reset=$reset)",
    async ({ activeKind, timeoutMs, reset }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const runId = `run-public-timeout-${activeKind ?? "untracked"}-${timeoutMs}`;
      const dedupe = new Map<string, DedupeEntry>();
      const started = createDeferredCore();
      const wait = agentJobs.waitForAgentJob;
      vi.spyOn(agentJobs, "waitForAgentJob").mockImplementationOnce((params) => {
        const pending = wait(params);
        started.resolve();
        return pending;
      });
      const timedOut = waitThroughGateway({ runId, timeoutMs }, activeKind);
      await started.promise;
      if (reset) {
        // Native worker shutdown joins its exit through setImmediate.
        vi.useRealTimers();
        await drainGlobalSingletonLifecycleState("restart");
      } else {
        await vi.advanceTimersByTimeAsync(timeoutMs);
      }
      await timedOut.promise;
      expect(timedOut.respond).toHaveBeenCalledWith(true, {
        runId,
        status: "timeout",
        ...(reset ? { timeoutPhase: "gateway_draining" } : {}),
      });
      const fresh = waitThroughGateway({ runId, timeoutMs: 0 }, activeKind);
      await fresh.promise;
      expect(fresh.respond).toHaveBeenCalledWith(true, { runId, status: "timeout" });
      completeRun(dedupe, runId, activeKind);
      const completed = waitThroughGateway({ runId, timeoutMs: 0 }, activeKind);
      await completed.promise;
      expect(completed.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, status: "ok", endedAt: 200 }),
      );
    },
  );

  it.each([
    {
      name: "late completion",
      payload: { status: "ok", startedAt: 100, endedAt: 300 },
      expected: { status: "timeout", endedAt: 200, timeoutPhase: "provider" },
    },
    {
      name: "late restart cancellation",
      payload: { status: "error", startedAt: 100, endedAt: 300, stopReason: "restart" },
      expected: { status: "timeout", endedAt: 200, timeoutPhase: "provider" },
    },
    {
      name: "earlier user cancellation",
      payload: { status: "error", startedAt: 100, endedAt: 150, stopReason: "rpc" },
      expected: { status: "error", endedAt: 150, stopReason: "rpc" },
    },
    {
      name: "earlier writer supersession",
      payload: { status: "error", startedAt: 100, endedAt: 150, stopReason: "superseded" },
      expected: { status: "error", endedAt: 150, stopReason: "superseded" },
    },
  ])("merges $name across agent and chat observations", async ({ name, payload, expected }) => {
    for (const timeoutFirst of [true, false]) {
      const runId = `run-cross-source-${name.replaceAll(" ", "-")}-${timeoutFirst}`;
      const dedupe = new Map<string, DedupeEntry>();
      const timeout = {
        dedupe,
        key: `agent:${runId}`,
        entry: {
          ts: 200,
          ok: false,
          payload: {
            runId,
            status: "timeout",
            startedAt: 100,
            endedAt: 200,
            timeoutPhase: "provider",
          },
        },
      };
      const other = {
        dedupe,
        key: `chat:${runId}`,
        entry: { ts: 300, ok: payload.status === "ok", payload: { runId, ...payload } },
      };

      for (const observation of timeoutFirst ? [timeout, other] : [other, timeout]) {
        setGatewayDedupeEntry(observation);
      }

      const waiter = waitThroughGateway({ runId, timeoutMs: 0 });
      await waiter.promise;
      expect(waiter.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, ...expected }),
      );
    }
  });

  it.each(["lifecycle-first", "dedupe-first"] as const)(
    "keeps terminal evidence when sticky status arrives $0",
    async (order) => {
      const runId = `run-reply-merge-${order}`;
      const dedupe = new Map<string, DedupeEntry>();
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 100 },
      });
      const lifecycleEnd = () =>
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt: 100,
            endedAt: 300,
            terminalDelivery: {
              status: "sent",
              resultCount: 1,
              target: "private-target",
            },
            terminalReceipt: terminalReceipt(runId),
            terminalReply: { disposition: "visible", text: "canonical reply" },
          },
        });
      const dedupeTimeout = () =>
        setGatewayDedupeEntry({
          dedupe,
          key: `agent:${runId}`,
          entry: {
            ts: 200,
            ok: false,
            payload: {
              runId,
              status: "timeout",
              startedAt: 100,
              endedAt: 200,
              timeoutPhase: "provider",
            },
          },
        });

      for (const observe of order === "lifecycle-first"
        ? [lifecycleEnd, dedupeTimeout]
        : [dedupeTimeout, lifecycleEnd]) {
        observe();
      }

      const waiter = waitThroughGateway({ runId, timeoutMs: 0 });
      await waiter.promise;
      expect(waiter.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          runId,
          status: "timeout",
          terminalDelivery: { status: "sent", resultCount: 1 },
          terminalReceipt: terminalReceipt(runId),
          terminalReply: { disposition: "visible", text: "canonical reply" },
        }),
      );
      expect(JSON.stringify(waiter.respond.mock.calls[0]?.[1])).not.toContain("private-target");
    },
  );
});
