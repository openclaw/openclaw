import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { attachLiveActivitySource, captureLiveActivitySource } from "./live-activity-source.js";

const persistLifecycle = vi.hoisted(() => vi.fn());
const ownerStatus = vi.hoisted(() => vi.fn());

vi.mock("./session-lifecycle-state.js", () => ({
  persistGatewaySessionLifecycleEvent: persistLifecycle,
}));
vi.mock("../infra/agent-run-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/agent-run-registry.js")>()),
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
    persistLifecycle.mockReset();
    ownerStatus.mockReset().mockReturnValue("active");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts one terminal write before the chat handler consumes it", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();

    const prepared = owner.observe(terminal);
    const consumed = owner.persist(terminal);

    expect(consumed).toBe(prepared);
    expect(persistLifecycle).toHaveBeenCalledOnce();
    await consumed;
    await owner.drain();
  });

  it("distinguishes reused run ids by their exact owner claim", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();
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
    expect(persistLifecycle).toHaveBeenCalledTimes(2);
    expect(owner.persist(successor)).toBe(successorPrepared);
    await Promise.all([firstPrepared, successorPrepared]);
    await owner.drain();
  });

  it("preserves private restart-recovery metadata for the durable write", async () => {
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
    });
    const owner = createSessionLifecyclePersistenceOwner();

    await owner.observe({ sessionKey: terminal.sessionKey, event });

    expect(persistLifecycle).toHaveBeenCalledWith({
      sessionKey: terminal.sessionKey,
      event: expect.objectContaining({
        lifecycleGeneration: "generation-recovery",
        mainSessionRestartRecovery: true,
      }),
    });
    await owner.drain();
  });

  it("persists a keyed error after the chat retry grace expires", async () => {
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();
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

  it.each(["terminal", "start"] as const)(
    "keeps %s writes alive until shutdown drains them",
    async (phase) => {
      const deferred = createDeferred();
      persistLifecycle.mockReturnValue(deferred.promise);
      const owner = createSessionLifecyclePersistenceOwner();
      if (phase === "terminal") {
        void owner.observe(terminal);
      } else {
        void owner.persist({ ...terminal, event: { ...terminal.event, data: { phase: "start" } } });
      }

      let drained = false;
      const drain = owner.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(drained).toBe(false);

      deferred.resolve();
      await drain;
      expect(drained).toBe(true);
    },
  );

  it("keeps a pending write available after its lookup grace expires", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred();
    persistLifecycle.mockReturnValue(deferred.promise);
    const owner = createSessionLifecyclePersistenceOwner();
    const prepared = owner.observe(terminal);
    await vi.advanceTimersByTimeAsync(60_000);

    const consumed = owner.persist(terminal);

    expect(consumed).toBe(prepared);
    deferred.resolve();
    await consumed;
    await owner.drain();
  });

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

  it.each(["committed", "no-op", "failure"] as const)(
    "holds an exact terminal through %s and releases only at persistence settlement",
    async (outcome) => {
      const commit = createDeferred();
      const release = vi.fn();
      const entered = vi.fn(() => release);
      const onCommitted = vi.fn();
      const entry: ChatAbortControllerEntry = {
        controller: new AbortController(),
        sessionKey: terminal.sessionKey,
        sessionId: terminal.event.sessionId,
        preparedSession: Object.freeze({
          sessionId: terminal.event.sessionId,
          lifecycleRevision: null,
        }),
        agentId: "main",
        lifecycleGeneration: terminal.event.lifecycleGeneration,
        liveActivityRun: Object.freeze({
          publicRunId: "public-run",
          internalRunId: terminal.event.runId,
        }),
        startedAtMs: 1_000,
        expiresAtMs: 60_000,
      };
      const event = { ...terminal.event, contextClaimId: "claim-1" };
      const source = captureLiveActivitySource(event, entry)!;
      attachLiveActivitySource(event, source);
      persistLifecycle.mockImplementation(async (params: PersistenceParams) => {
        await commit.promise;
        params.assertCommitAllowed?.();
        if (outcome === "failure") {
          throw new Error("write failed");
        }
        if (outcome === "committed") {
          params.onCommitted?.({
            source,
            publicRunId: source.publicRunId,
            agentId: source.agentId,
            sessionKey: source.sessionKey,
            ...source.preparedSession,
            snapshot: {
              sourceIncarnation: source.sourceIncarnation,
              status: "done",
              observedAtMs: 2_000,
            },
          });
        }
      });
      const owner = createSessionLifecyclePersistenceOwner({
        onCommitted,
        onTerminalTransition: entered,
      });
      const pending = owner.observe({
        ...terminal,
        event,
        authority: {
          runId: event.runId,
          claimId: "claim-1",
          lifecycleGeneration: event.lifecycleGeneration,
        },
      });
      const settlement = pending.catch(() => undefined);
      expect(entered).toHaveBeenCalledWith(source, expect.any(Function));
      expect(release).not.toHaveBeenCalled();
      expect(onCommitted).not.toHaveBeenCalled();
      commit.resolve();
      await settlement;
      expect(release).toHaveBeenCalledOnce();
      expect(onCommitted).toHaveBeenCalledTimes(outcome === "committed" ? 1 : 0);
      await owner.drain();
    },
  );

  it.each(["execution closed", "registration replaced", "prepared identity replaced"] as const)(
    "separates local cancellation write authority from %s",
    async (change) => {
      const commit = createDeferred();
      const generation = getAgentEventLifecycleGeneration();
      const entry: ChatAbortControllerEntry = {
        controller: new AbortController(),
        sessionKey: terminal.sessionKey,
        sessionId: terminal.event.sessionId,
        preparedSession: Object.freeze({
          sessionId: terminal.event.sessionId,
          lifecycleRevision: null,
        }),
        agentId: "main",
        lifecycleGeneration: generation,
        liveActivityRun: Object.freeze({
          publicRunId: "public-run",
          internalRunId: terminal.event.runId,
        }),
        startedAtMs: 1_000,
        expiresAtMs: 60_000,
      };
      const entries = new Map([["public-run", entry]]);
      const event = {
        ...terminal.event,
        runId: "public-run",
        lifecycleGeneration: generation,
        data: { phase: "end", aborted: true, endedAt: 2_000 },
      };
      let wrote = false;
      persistLifecycle.mockImplementation(async (params: PersistenceParams) => {
        await commit.promise;
        params.assertCommitAllowed?.();
        wrote = true;
      });
      const owner = createSessionLifecyclePersistenceOwner();
      let aliased: Promise<void> | undefined;
      owner.withLocalAbort({ entry, entries, event }, () => {
        entry.controller.abort();
        ownerStatus.mockReturnValue("released");
        aliased = owner.observe({ sessionKey: terminal.sessionKey, event });
        if (change === "registration replaced") {
          entries.set("public-run", { ...entry, controller: new AbortController() });
        } else if (change === "prepared identity replaced") {
          entry.preparedSession = Object.freeze({
            ...entry.preparedSession!,
            lifecycleRevision: "new-generation",
          });
        }
      });
      expect(aliased).toBe(entry.projectSessionTerminalPersistence);
      expect(persistLifecycle).toHaveBeenCalledOnce();
      expect(persistLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedSession: { sessionId: terminal.event.sessionId, lifecycleRevision: null },
          event: expect.objectContaining({
            runId: terminal.event.runId,
            clientRunId: "public-run",
          }),
        }),
      );
      const settlement = aliased!.catch(() => undefined);
      commit.resolve();
      await settlement;
      expect(wrote).toBe(change === "execution closed");
      expect(entry.projectSessionTerminalPersistence).toBeUndefined();
      expect(ownerStatus).not.toHaveBeenCalled();
      await owner.drain();
    },
  );

  it.each([
    { name: "end", data: { phase: "end" } },
    { name: "native cancellation", data: { phase: "error", aborted: true, stopReason: "aborted" } },
    { name: "fallback exhaustion", data: { phase: "error", fallbackExhaustedFailure: true } },
    { name: "settled execution failure", data: { phase: "error", executionSettled: true } },
  ])("does not restart $name after its prepared promise expires", async ({ data }) => {
    vi.useFakeTimers();
    persistLifecycle.mockResolvedValue(undefined);
    const owner = createSessionLifecyclePersistenceOwner();
    const event = { ...terminal, event: { ...terminal.event, data } };
    await owner.observe(event);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(owner.persist(event)).rejects.toMatchObject({
      code: "ERR_STALE_GATEWAY_LIFECYCLE",
    });
    expect(persistLifecycle).toHaveBeenCalledOnce();
  });
});
