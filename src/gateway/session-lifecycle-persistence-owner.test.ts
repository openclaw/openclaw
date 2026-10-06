import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

const persistLifecycle = vi.hoisted(() => vi.fn());
const ownerStatus = vi.hoisted(() => vi.fn());
const runtimeConfig = vi.hoisted<{ value: OpenClawConfig }>(() => ({ value: {} }));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => runtimeConfig.value,
}));

// mock-isolation: Hold persistence settlement without opening a database.
vi.mock("./session-lifecycle-state.js", () => ({
  prepareGatewaySessionLifecycleEvent: (params: unknown) => () => persistLifecycle(params),
}));
vi.mock("../infra/agent-run-registry.js", () => ({
  getAgentRunContextOwnerStatus: ownerStatus,
}));

import { createSessionLifecyclePersistenceOwner } from "./session-lifecycle-persistence-owner.js";

type PersistenceParams = Parameters<
  typeof import("./session-lifecycle-state.js").persistGatewaySessionLifecycleEvent
>[0];

const terminal = {
  sessionKey: "agent:main:main",
  event: {
    runId: "run-1",
    seq: 2,
    stream: "lifecycle",
    lifecycleGeneration: "generation-1",
    sessionId: "session-1",
    ts: 2_000,
    data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
  },
};

function fixture() {
  const time = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(time.clock);
  onTestFinished(() => scheduler.stop());
  return { owner: createSessionLifecyclePersistenceOwner(scheduler), scheduler, time };
}

describe("session lifecycle persistence owner", () => {
  beforeEach(() => {
    runtimeConfig.value = {};
    persistLifecycle.mockReset();
    ownerStatus.mockReset().mockReturnValue("active");
  });

  it("starts one terminal write before the chat handler consumes it", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const { owner } = fixture();

    const prepared = owner.observe(terminal);
    const consumed = owner.persist(terminal);

    expect(consumed).toBe(prepared);
    expect(persistLifecycle).toHaveBeenCalledOnce();
    await consumed;
    await owner.drain();
  });

  it("distinguishes reused run ids by their exact owner claim", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const { owner } = fixture();
    const first = {
      ...terminal,
      event: { ...terminal.event, contextClaimId: "claim-1" },
    };
    const successor = {
      ...terminal,
      event: { ...terminal.event, contextClaimId: "claim-2" },
    };

    const firstPrepared = owner.observe(first);
    const successorPrepared = owner.observe(successor);

    expect(successorPrepared).not.toBe(firstPrepared);
    expect(owner.persist(successor)).toBe(successorPrepared);
    await Promise.all([firstPrepared, successorPrepared]);
    expect(persistLifecycle).toHaveBeenCalledTimes(2);
    await owner.drain();
  });

  it("preserves private lifecycle metadata for the durable write", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const event = {
      runId: "run-recovery",
      seq: 2,
      stream: "lifecycle",
      sessionId: "session-recovery",
      ts: 2_000,
      data: { phase: "end", startedAt: 1_000, endedAt: 2_000 },
    } as typeof terminal.event & { mainSessionRestartRecovery?: true };
    Object.defineProperties(event, {
      lifecycleGeneration: { value: "generation-recovery", enumerable: false },
      mainSessionRestartRecovery: { value: true, enumerable: false },
      controlUiVisible: { value: true, enumerable: false },
      isHeartbeat: { value: false, enumerable: false },
    });
    const { owner } = fixture();

    await owner.observe({ sessionKey: terminal.sessionKey, event });

    expect(persistLifecycle).toHaveBeenCalledWith({
      sessionKey: terminal.sessionKey,
      event: expect.objectContaining({
        lifecycleGeneration: "generation-recovery",
        mainSessionRestartRecovery: true,
        controlUiVisible: true,
        isHeartbeat: false,
      }),
    });
    await owner.drain();
  });

  it("persists a keyed error after the chat retry grace expires", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const { owner } = fixture();
    const error = {
      ...terminal,
      event: {
        ...terminal.event,
        data: { phase: "error", error: "fallback exhausted", endedAt: 2_000 },
      },
    };

    await owner.persist(error);

    expect(persistLifecycle).toHaveBeenCalledOnce();
    expect(persistLifecycle).toHaveBeenCalledWith(error);
  });

  it("keeps terminal writes alive until shutdown drains them", async () => {
    const deferred = createDeferred();
    persistLifecycle.mockReturnValue(deferred.promise);
    const { owner, scheduler } = fixture();
    void owner.observe(terminal);
    scheduler.beginClose();

    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    deferred.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  it("settles a start before a following terminal while shutdown drains both", async () => {
    const releaseStart = createDeferred();
    const phases: unknown[] = [];
    persistLifecycle.mockImplementation(async (params: PersistenceParams) => {
      if (params.event.data?.phase === "start") {
        await releaseStart.promise;
      }
      phases.push(params.event.data?.phase);
    });
    const { owner, scheduler } = fixture();
    const start = owner.persist({
      ...terminal,
      event: { ...terminal.event, data: { phase: "start", startedAt: 1_000 } },
    });
    const end = owner.observe(terminal);
    scheduler.beginClose();
    const draining = owner.drain();
    expect(persistLifecycle).toHaveBeenCalledOnce();
    releaseStart.resolve();
    await Promise.all([start, end, draining]);
    expect(phases).toEqual(["start", "end"]);
  });

  it.each([false, true])(
    "settles a start before its terminal while draining (global alias: %s)",
    async (globalAlias) => {
      if (globalAlias) {
        runtimeConfig.value = {
          agents: { ownership: "explicit", entries: { main: {}, research: {} } },
          session: { scope: "global" },
        };
      }
      const releaseStart = createDeferred();
      const phases: unknown[] = [];
      persistLifecycle.mockImplementation(async (params: PersistenceParams) => {
        if (params.event.data?.phase === "start") {
          await releaseStart.promise;
        }
        phases.push(params.event.data?.phase);
      });
      const { owner, scheduler } = fixture();
      const start = owner.persist({
        ...terminal,
        sessionKey: globalAlias ? "agent:research:main" : terminal.sessionKey,
        event: { ...terminal.event, data: { phase: "start", startedAt: 1_000 } },
      });
      const end = owner.observe({
        ...terminal,
        ...(globalAlias ? { agentId: "research", sessionKey: "global" } : {}),
      });
      scheduler.beginClose();
      const draining = owner.drain();
      try {
        expect(persistLifecycle).toHaveBeenCalledOnce();
        releaseStart.resolve();
        await Promise.all([start, end, draining]);
        expect(phases).toEqual(["start", "end"]);
      } finally {
        releaseStart.resolve();
        await Promise.allSettled([start, end, draining]);
      }
    },
  );

  it.each([false, true])(
    "keeps an expired write available until settlement (consumed while pending: %s)",
    async (consumeWhilePending) => {
      const deferred = createDeferred();
      persistLifecycle.mockReturnValue(deferred.promise);
      const { owner, time } = fixture();
      const prepared = owner.observe(terminal);
      await time.advanceBy(60_000);

      expect(owner.observe(terminal)).toBe(prepared);
      if (consumeWhilePending) {
        expect(owner.persist(terminal)).toBe(prepared);
      }
      deferred.resolve();
      await prepared;
      if (!consumeWhilePending) {
        await expect(owner.persist(terminal)).rejects.toMatchObject({
          code: "ERR_STALE_GATEWAY_LIFECYCLE",
        });
      }
      expect(persistLifecycle).toHaveBeenCalledOnce();
      await owner.drain();
    },
  );

  it("keeps a prepared write available while shutdown drain waits", async () => {
    const deferred = createDeferred();
    persistLifecycle.mockReturnValue(deferred.promise);
    const { owner } = fixture();
    const prepared = owner.observe(terminal);
    const draining = owner.drain();
    await Promise.resolve();

    const consumed = owner.persist(terminal);

    expect(consumed).toBe(prepared);
    deferred.resolve();
    await Promise.all([consumed, draining]);
  });

  it("rejects a terminal write when its exact claim retires before commit", async () => {
    const beforeCommit = createDeferred();
    const commitReached = createDeferred();
    let sessionStatus = "running";
    persistLifecycle.mockImplementation(async (params: PersistenceParams) => {
      commitReached.resolve();
      await beforeCommit.promise;
      params.assertCommitAllowed?.();
      sessionStatus = "done";
    });
    const { owner } = fixture();
    const persistence = owner.observe({
      ...terminal,
      authority: {
        claimId: "claim-1",
        lifecycleGeneration: "generation-1",
        runId: "run-1",
      },
    });
    await commitReached.promise;

    ownerStatus.mockReturnValue(undefined);
    beforeCommit.resolve();

    await expect(persistence).rejects.toMatchObject({
      name: "AbortError",
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(sessionStatus).toBe("running");
  });

  it("rejects a deferred error when its exact claim retires before commit", async () => {
    const beforeCommit = createDeferred();
    const commitReached = createDeferred();
    let sessionStatus = "running";
    persistLifecycle.mockImplementation(async (params: PersistenceParams) => {
      commitReached.resolve();
      await beforeCommit.promise;
      params.assertCommitAllowed?.();
      sessionStatus = "failed";
    });
    const { owner } = fixture();
    const persistence = owner.persist({
      ...terminal,
      event: {
        ...terminal.event,
        contextClaimId: "claim-error",
        data: { phase: "error", error: "fallback exhausted", endedAt: 2_000 },
      },
    });
    await commitReached.promise;

    ownerStatus.mockReturnValue(undefined);
    beforeCommit.resolve();

    await expect(persistence).rejects.toMatchObject({
      name: "AbortError",
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(sessionStatus).toBe("running");
  });

  it.each([
    { name: "end", data: { phase: "end" } },
    { name: "native cancellation", data: { phase: "error", aborted: true, stopReason: "aborted" } },
    { name: "fallback exhaustion", data: { phase: "error", fallbackExhaustedFailure: true } },
    { name: "settled execution failure", data: { phase: "error", executionSettled: true } },
  ])("does not restart $name after its prepared promise expires", async ({ data }) => {
    persistLifecycle.mockResolvedValue(undefined);
    const { owner, time } = fixture();
    const event = { ...terminal, event: { ...terminal.event, data } };
    await owner.observe(event);
    await time.advanceBy(60_000);

    await expect(owner.persist(event)).rejects.toMatchObject({
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(persistLifecycle).toHaveBeenCalledOnce();
  });
});
