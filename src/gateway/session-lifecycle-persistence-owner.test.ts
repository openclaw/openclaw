import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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

describe("session lifecycle persistence owner", () => {
  beforeEach(() => {
    runtimeConfig.value = {};
    persistLifecycle.mockReset();
    ownerStatus.mockReset().mockReturnValue("active");
  });

  it.each([false, true])("separates distinct runtime events (new claim: %s)", async (newClaim) => {
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();
    const first = {
      ...terminal,
      event: { ...terminal.event, contextClaimId: "claim-1" },
    };
    const successor = {
      ...terminal,
      event: { ...terminal.event, contextClaimId: newClaim ? "claim-2" : "claim-1" },
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
      contextClaimId: { value: "claim-recovery", enumerable: false },
    });
    const owner = createSessionLifecyclePersistenceOwner();

    await owner.observe({ sessionKey: terminal.sessionKey, clientRunId: "client-recovery", event });

    expect(persistLifecycle).toHaveBeenCalledWith({
      sessionKey: terminal.sessionKey,
      clientRunId: "client-recovery",
      event: expect.objectContaining({
        lifecycleGeneration: "generation-recovery",
        mainSessionRestartRecovery: true,
        controlUiVisible: true,
        contextClaimId: "claim-recovery",
      }),
    });
    await owner.drain();
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
      const owner = createSessionLifecyclePersistenceOwner();
      const start = owner.persist({
        ...terminal,
        sessionKey: globalAlias ? "agent:research:main" : terminal.sessionKey,
        event: { ...terminal.event, data: { phase: "start", startedAt: 1_000 } },
      });
      const end = owner.observe({
        ...terminal,
        ...(globalAlias ? { agentId: "research", sessionKey: "global" } : {}),
      });
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

  it("keeps a prepared write available while shutdown drain waits", async () => {
    const deferred = createDeferred();
    persistLifecycle.mockReturnValue(deferred.promise);
    const owner = createSessionLifecyclePersistenceOwner();
    const prepared = owner.observe(terminal);
    const draining = owner.drain();
    await Promise.resolve();

    const consumed = owner.persist(terminal);

    expect(consumed).toBe(prepared);
    deferred.resolve();
    await Promise.all([consumed, draining]);
    await expect(owner.persist(terminal)).rejects.toMatchObject({
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
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
    const owner = createSessionLifecyclePersistenceOwner();
    const observed = {
      ...terminal,
      authority: {
        claimId: "claim-1",
        lifecycleGeneration: "generation-1",
        runId: "run-1",
      },
    };
    const persistence = owner.observe(observed);
    await commitReached.promise;

    ownerStatus.mockReturnValue(undefined);
    beforeCommit.resolve();

    await expect(persistence).rejects.toMatchObject({
      name: "AbortError",
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(sessionStatus).toBe("running");
    expect(owner.persist(observed)).toBe(persistence);
    await expect(owner.persist(observed)).rejects.toMatchObject({
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(persistLifecycle).toHaveBeenCalledOnce();
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
    const owner = createSessionLifecyclePersistenceOwner();
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
  ])("reuses pending and settled $name only for the original runtime event", async ({ data }) => {
    const deferred = createDeferred();
    persistLifecycle.mockReturnValue(deferred.promise);
    const owner = createSessionLifecyclePersistenceOwner();
    const event = { ...terminal, event: { ...terminal.event, data } };
    const prepared = owner.observe(event);
    expect(owner.observe(event)).toBe(prepared);
    expect(owner.persist(event)).toBe(prepared);
    deferred.resolve();
    await prepared;

    expect(owner.persist(event)).toBe(prepared);
    await expect(owner.persist({ ...event, event: { ...event.event } })).rejects.toMatchObject({
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    const { seq: _seq, ...withoutSequence } = event.event;
    await expect(owner.persist({ ...event, event: withoutSequence })).rejects.toMatchObject({
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(persistLifecycle).toHaveBeenCalledOnce();
    await owner.drain();
  });
});
