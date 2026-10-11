import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionQuestionCustodyRetiredError } from "../config/sessions/session-questions-custody-error.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { InternalAgentTurnDispatchOptions } from "./agent-turn/internal-facade.types.js";
import { createQuestionCompletionReceipts } from "./question-completion-receipts.js";
import { createQuestionContinuationWork } from "./question-continuation-work.js";
import { dispatchQuestionContinuation } from "./question-continuation.js";
import { createChannelAutostartRecovery } from "./server-channel-autostart-recovery.js";
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import { createMockGatewayRecoveryRuntime } from "./server-recovery-runtime.test-support.js";

const state = vi.hoisted(() => ({
  operate: vi.fn(),
  readCustody: vi.fn(),
  restore: vi.fn(),
  prepareChannel: vi.fn(),
  captureChannel: vi.fn(),
}));
vi.mock("../config/sessions/session-questions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-questions.js")>()),
  executeSessionQuestionOperation: state.operate,
  readSessionQuestionCustody: state.readCustody,
}));
vi.mock("../infra/agent-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/agent-events.js")>()),
  getAgentEventLifecycleGeneration: () => "epoch",
}));
vi.mock("./operator-run-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-run-recovery.js")>()),
  restoreGatewayQuestionOperatorRecovery: state.restore,
}));
vi.mock("./operator-run-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./operator-run-authority.js")>()),
  captureChannelOperatorRunAuthority: state.captureChannel,
}));
vi.mock("./channel-operator-authority.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-operator-authority.js")>()),
  prepareChannelOperatorAdmin: state.prepareChannel,
}));
vi.mock("./server-plugin-runtime-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-plugin-runtime-client.js")>()),
  createSyntheticPluginRuntimeClient: (source: unknown) => source,
}));

function question(): DurableQuestion {
  return {
    record: {
      id: "ask_fixture",
      agentId: "main",
      sessionKey: "agent:main:test",
      status: "answered",
      createdAtMs: 1,
      expiresAtMs: 2,
      questions: [],
      answers: { answers: {} },
    },
    sessionKey: "agent:main:test",
    sessionId: "session",
    lifecycleRevision: "revision",
    sessionBinding: {
      agentId: "main",
      sessionKey: "agent:main:test",
      storePath: "/tmp/fixture.db",
      databasePath: "/tmp/fixture.db",
      databaseIdentity: { identity: "fixture" },
      sessionId: "session",
      lifecycleRevision: "revision",
    },
    provenance: {
      issuer: "operator",
      sourceRunId: "original",
      recoverySource: {
        version: 1,
        agentId: "main",
        sessionKey: "agent:main:test",
        sessionId: "session",
        lifecycleRevision: "revision",
        sourceRunId: "original",
        snapshot: {
          profileId: "original-person",
          scopes: ["operator.write"],
          assignedRole: null,
          githubLogin: null,
          grant: null,
          aliasBindingIds: [],
          authPolicy: {
            generation: "",
            grantGeneration: "generation",
            role: "operator",
            authMethod: "token",
          },
          controlUiAdmin: false,
          localOperator: false,
          sourceIngress: "internal",
        },
      },
    },
    continuation: { status: "owed" },
  };
}

function fixture(saved = question()) {
  state.readCustody.mockImplementation((binding, id, assertCurrent) => {
    expect(binding).toBe(saved.sessionBinding);
    return state.operate({ ...binding, assertCurrent }, { kind: "get", id });
  });
  const authority = {
    profileId: "original-person",
    scopes: ["operator.write"],
    assertCurrent: vi.fn(),
  };
  const dispatch = vi.fn(
    async (_request: AgentRunRequest, _options: InternalAgentTurnDispatchOptions) => ({}),
  );
  const facade = vi.fn(async (_principal: { client: unknown }) => ({ dispatch }));
  let canonical = saved;
  state.operate.mockImplementation(async (_scope, operation) => {
    if (operation.kind === "get") {
      return canonical;
    }
    canonical = {
      ...saved,
      continuation: {
        status:
          operation.kind === "finish"
            ? operation.interrupted
              ? "interrupted"
              : "settled"
            : operation.kind === "block"
              ? "blocked"
              : "claimed",
        runId: operation.runId,
        gatewayEpoch: operation.gatewayEpoch ?? "epoch",
        reason: operation.reason,
      },
    };
    return canonical;
  });
  state.restore.mockResolvedValue({ authority, release: vi.fn() });
  return {
    saved,
    authority,
    dispatch,
    facade,
    params: {
      question: saved,
      scope: saved.sessionBinding,
      context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
      runtime: {
        isAvailable: () => true,
        createAgentTurnFacade: facade,
        recovery: createMockGatewayRecoveryRuntime(),
      } as unknown as GatewayInstanceRuntime,
      assertCurrent: vi.fn(),
    },
  };
}

describe("durable question continuation custody", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retains the owed answer during native crash-loop quarantine and resumes at its owner deadline", async () => {
    const f = fixture();
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const tracked = new AsyncWorkScope();
    const pausedUntilMs = clock.clock.now() + 60_000;
    let suppression: object | null = {};
    const prepare = createChannelAutostartRecovery({
      getSuppression: () => suppression,
      clearSuppression: () => {
        suppression = null;
      },
      tryRecover: async () => (clock.clock.now() < pausedUntilMs ? pausedUntilMs : undefined),
      signal: scheduler.signal,
      startChannels: async () => {},
    });
    f.params.runtime.recovery = createMockGatewayRecoveryRuntime({
      prepareRestartRecovery: prepare,
    });
    const work = createQuestionContinuationWork({
      scheduler,
      track: (run) => tracked.track(run),
      isClosing: () => false,
    });
    const run = async (signal: AbortSignal) => {
      const receipt = await dispatchQuestionContinuation({ ...f.params, signal });
      return receipt.status === "admission_owed" ? receipt : undefined;
    };
    try {
      await work.offer(f.saved, run);
      expect(f.facade).not.toHaveBeenCalled();
      expect(state.restore).not.toHaveBeenCalled();
      expect(state.operate).not.toHaveBeenCalled();
      expect(f.saved.continuation.status).toBe("owed");
      expect(clock.armedAtMs).toBe(pausedUntilMs);
      expect(work.offer(structuredClone(f.saved), run)).toBeUndefined();
      await clock.advanceTo(pausedUntilMs - 1);
      expect(f.dispatch).not.toHaveBeenCalled();
      await clock.advanceTo(pausedUntilMs);
      await tracked.drain();
      expect(suppression).toBeNull();
      expect(state.restore).toHaveBeenCalledTimes(1);
      expect(f.dispatch).toHaveBeenCalledTimes(1);
      expect(state.operate.mock.calls.filter(([, op]) => op.kind === "finish")).toHaveLength(1);
    } finally {
      work.beginClose();
      await work.stop();
      await tracked.drain();
      await scheduler.stop();
    }
  });

  it("does not dispatch under a system principal when original authority cannot be restored", async () => {
    const f = fixture();
    state.restore.mockResolvedValue(undefined);
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow(
      "original caller authority",
    );
    expect(f.facade).not.toHaveBeenCalled();
    expect(state.operate.mock.calls.some(([, op]) => op.kind === "claim")).toBe(false);
  });

  it("rejects replaced durable source custody before authority restoration", async () => {
    const f = fixture();
    state.operate.mockResolvedValue({ ...f.saved, lifecycleRevision: "replacement" });
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("custody changed");
    expect(state.restore).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it("rejects a canonical claim receipt owned by another run before continuation execution", async () => {
    const f = fixture();
    state.operate.mockImplementation(async (_scope, operation) => ({
      ...f.saved,
      continuation:
        operation.kind === "get" && !state.operate.mock.calls.some(([, op]) => op.kind === "claim")
          ? f.saved.continuation
          : { status: "claimed", runId: "another-run", gatewayEpoch: "epoch" },
    }));
    f.dispatch.mockImplementation(async (request, options) => {
      expect(request.expectedExistingSessionLifecycleRevision).toBe("revision");
      await options.commitAdmission!({
        runId: request.idempotencyKey,
        sessionId: "session",
        sessionKey: "agent:main:test",
        storePath: "/tmp/fixture.db",
        lifecycleGeneration: "epoch",
        assertCurrent: () => {},
      });
      throw new Error("execution must never be reached");
    });
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("claim was not admitted");
    expect(state.operate.mock.calls.some(([, operation]) => operation.kind === "finish")).toBe(
      false,
    );
  });

  it("records an interrupted claim when reset fences the admitted turn after worker commit", async () => {
    const f = fixture();
    f.dispatch.mockImplementation(async (_request, options) => {
      await options.commitAdmission!({
        runId: _request.idempotencyKey,
        sessionId: "session",
        sessionKey: "agent:main:test",
        storePath: "/tmp/fixture.db",
        lifecycleGeneration: "epoch",
        assertCurrent: () => {},
      });
      throw new Error("reset retired the admitted session");
    });
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("reset retired");
    expect(state.operate.mock.calls.at(-1)?.[1]).toMatchObject({
      kind: "finish",
      interrupted: true,
    });
    expect(state.restore).toHaveBeenCalledWith(
      expect.objectContaining({ expectedQuestion: f.saved }),
    );
    expect(f.facade.mock.calls.at(0)?.[0].client).toMatchObject({
      operatorRoleActor: { kind: "operator", profileId: "original-person" },
    });
  });

  it.each(["own", "another", "revoked"] as const)(
    "reconciles an uncertain claim acknowledgement for the %s run without executing",
    async (owner) => {
      const f = fixture();
      let committed: DurableQuestion | undefined;
      const executed = vi.fn();
      state.operate.mockImplementation(async (_scope, operation) => {
        if (operation.kind === "get") {
          return committed ?? f.saved;
        }
        if (operation.kind === "claim") {
          committed = {
            ...f.saved,
            continuation: {
              status: "claimed",
              runId: owner !== "another" ? operation.runId : "another-run",
              gatewayEpoch: operation.gatewayEpoch,
            },
          };
          if (owner === "revoked") {
            throw new Error("authority revoked after commit");
          }
          throw new SqliteWorkerError("worker acknowledgement lost", "outcome-unknown");
        }
        if (operation.kind === "finish" && committed) {
          committed = {
            ...committed,
            continuation: {
              ...committed.continuation,
              status: "interrupted",
              reason: operation.reason,
            },
          };
        }
        return committed;
      });
      f.dispatch.mockImplementation(async (request, options) => {
        await options.commitAdmission!({
          runId: request.idempotencyKey,
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/tmp/fixture.db",
          lifecycleGeneration: "epoch",
          assertCurrent() {},
        });
        executed();
        return {};
      });
      await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow(
        owner === "revoked" ? "revoked after commit" : "acknowledgement lost",
      );
      expect(executed).not.toHaveBeenCalled();
      expect(
        state.operate.mock.calls.find(([, operation]) => operation.kind === "claim")?.[1],
      ).toMatchObject({ expectedQuestion: f.saved });
      const finishes = state.operate.mock.calls.filter(
        ([, operation]) => operation.kind === "finish",
      );
      expect(finishes).toHaveLength(owner !== "another" ? 1 : 0);
      if (owner !== "another") {
        expect(finishes[0]?.[1]).toMatchObject({ interrupted: true, expectedQuestion: f.saved });
      }
    },
  );

  it("retains the validated channel recovery reference for subsequent durable questions", async () => {
    const f = fixture();
    const reference = { version: 1, id: "validated-channel" } as const;
    f.saved.provenance = {
      issuer: "channel",
      sourceRunId: "original",
      channelAuthorizationReference: reference,
    };
    state.prepareChannel.mockResolvedValue({
      operatorProfile: { profileId: "original-person" },
      recoveryReference: reference,
      signal: new AbortController().signal,
      isCurrent: () => true,
    });
    state.captureChannel.mockReturnValue(f.authority);
    await dispatchQuestionContinuation(f.params);
    expect(state.captureChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channelRecoveryReference: reference,
      }),
    );
  });

  it("does not clean up a replacement question after captured custody retires", async () => {
    const f = fixture();
    state.operate.mockRejectedValue(
      new SessionQuestionCustodyRetiredError("Question custody retired"),
    );
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("custody retired");
    expect(state.operate.mock.calls.map(([, operation]) => operation.kind)).toEqual(["get"]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });

  it.each(["before commit", "after commit", "repair ACK"] as const)(
    "repairs a completed turn receipt lost %s without dispatching or interrupting again",
    async (fault) => {
      const f = fixture();
      let canonical = f.saved;
      let finishAttempts = 0;
      state.operate.mockImplementation(async (_scope, operation) => {
        if (operation.kind === "get") {
          return canonical;
        }
        if (operation.kind === "claim") {
          canonical = {
            ...f.saved,
            continuation: {
              status: "claimed",
              runId: operation.runId,
              gatewayEpoch: operation.gatewayEpoch,
            },
          };
          return canonical;
        }
        if (operation.kind === "finish") {
          expect(operation.interrupted).toBe(false);
          finishAttempts++;
          if (finishAttempts === 1 && fault !== "after commit") {
            throw new Error("Receipt write unavailable");
          }
          canonical = {
            ...canonical,
            continuation: { ...canonical.continuation, status: "settled" },
          };
          if (finishAttempts === 1 || fault === "repair ACK") {
            throw new SqliteWorkerError("Receipt ACK lost", "outcome-unknown");
          }
          return canonical;
        }
        throw new Error("Completed execution must not be blocked or interrupted.");
      });
      f.dispatch.mockImplementation(async (request, options) => {
        await options.commitAdmission!({
          runId: request.idempotencyKey,
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/tmp/fixture.db",
          lifecycleGeneration: "epoch",
          assertCurrent() {},
        });
        return {};
      });
      await expect(dispatchQuestionContinuation(f.params)).resolves.toMatchObject({
        status: "settled",
      });
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(finishAttempts).toBe(fault === "after commit" ? 1 : 2);
      expect(canonical.continuation.status).toBe("settled");
      expect(
        state.operate.mock.calls
          .filter(([, operation]) => operation.kind === "finish")
          .every(([, operation]) => operation.interrupted === false),
      ).toBe(true);
    },
  );
  it.each(["available", "retired", "close"] as const)(
    "retains only a completed receipt through prolonged outage until %s",
    async (outcome) => {
      const f = fixture();
      let canonical = f.saved;
      let completed = false;
      let available = false;
      let retired = false;
      const release = vi.fn();
      state.restore.mockResolvedValue({ authority: f.authority, release });
      state.operate.mockImplementation(async (_scope, operation) => {
        if (retired) {
          throw new SessionQuestionCustodyRetiredError("replaced");
        }
        if (completed && !available) {
          throw new Error("persistent storage outage");
        }
        if (operation.kind === "get") {
          return canonical;
        }
        if (operation.kind === "claim") {
          canonical = {
            ...f.saved,
            continuation: {
              status: "claimed",
              runId: operation.runId,
              gatewayEpoch: operation.gatewayEpoch,
            },
          };
          return canonical;
        }
        if (operation.kind === "finish") {
          expect(operation.interrupted).toBe(false);
          canonical = {
            ...canonical,
            continuation: { ...canonical.continuation, status: "settled" },
          };
          return canonical;
        }
        throw new Error("Completed effects cannot be blocked");
      });
      f.dispatch.mockImplementation(async (request, options) => {
        await options.commitAdmission!({
          runId: request.idempotencyKey,
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/tmp/fixture.db",
          lifecycleGeneration: "epoch",
          assertCurrent() {},
        });
        completed = true;
        return {};
      });
      const receipt = await dispatchQuestionContinuation(f.params);
      expect(receipt.status).toBe("completion_owed");
      expect(release).toHaveBeenCalledOnce();
      if (receipt.status !== "completion_owed") {
        throw new Error("Missing completed obligation");
      }
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const settled = vi.fn(async () => {});
      const owner = createQuestionCompletionReceipts({
        scheduler,
        warn: vi.fn(),
        onSettled: settled,
      });
      try {
        owner.offer(receipt);
        owner.offer(receipt);
        await clock.advanceBy(1_000);
        await clock.advanceBy(2_000);
        expect(f.dispatch).toHaveBeenCalledOnce();
        expect(settled).not.toHaveBeenCalled();
        if (outcome === "available") {
          available = true;
        } else if (outcome === "retired") {
          retired = true;
        } else {
          owner.beginClose();
        }
        await clock.advanceBy(4_000);
        expect(settled).toHaveBeenCalledTimes(outcome === "available" ? 1 : 0);
        expect(canonical.continuation.status).toBe(outcome === "available" ? "settled" : "claimed");
        expect(scheduler.nextWakeAtMs).toBeNull();
        const calls = state.operate.mock.calls.length;
        await clock.advanceBy(60_000);
        expect(state.operate).toHaveBeenCalledTimes(calls);
        expect(f.dispatch).toHaveBeenCalledOnce();
      } finally {
        await owner.stop();
        await scheduler.stop();
      }
    },
  );
});

describe("pre-admission infrastructure recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["available", "retired", "close"] as const)(
    "keeps pre-admission infrastructure debt until %s without blocking",
    async (outcome) => {
      const f = fixture();
      let available = false;
      let retired = false;
      state.readCustody.mockImplementation(async () => {
        if (retired) {
          throw new SessionQuestionCustodyRetiredError("replacement");
        }
        if (!available) {
          throw new AggregateError([new SqliteWorkerError("Temporary", "unavailable")]);
        }
        return f.saved;
      });
      f.dispatch.mockImplementation(async (request, options) => {
        if (!options.commitAdmission) {
          throw new Error("Missing native claim owner");
        }
        await options.commitAdmission({
          runId: request.idempotencyKey,
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/tmp/fixture.db",
          lifecycleGeneration: "epoch",
          assertCurrent() {},
        });
        return {};
      });
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const scope = new AsyncWorkScope();
      const work = createQuestionContinuationWork({
        scheduler,
        track: (run) => scope.track(run),
        isClosing: () => false,
      });
      const run = vi.fn(async () => {
        try {
          const result = await dispatchQuestionContinuation(f.params);
          return result.status === "admission_owed" ? result : undefined;
        } catch (error) {
          if (!(error instanceof SessionQuestionCustodyRetiredError)) {
            throw error;
          }
        }
        return undefined;
      });
      try {
        await work.offer(f.saved, run);
        expect(work.offer(structuredClone(f.saved), run)).toBeUndefined();
        await clock.advanceBy(1_000);
        await clock.advanceBy(2_000);
        expect(f.dispatch).not.toHaveBeenCalled();
        expect(state.operate).not.toHaveBeenCalled();
        if (outcome === "available") {
          available = true;
        }
        if (outcome === "retired") {
          retired = true;
        }
        if (outcome === "close") {
          work.beginClose();
        }
        await clock.advanceBy(4_000);
        expect(f.dispatch).toHaveBeenCalledTimes(outcome === "available" ? 1 : 0);
        expect(state.operate.mock.calls.some(([, op]) => op.kind === "block")).toBe(false);
        expect(clock.armedAtMs).toBeNull();
      } finally {
        work.beginClose();
        await work.stop();
        await scope.drain();
        await scheduler.stop();
      }
    },
  );

  it("does not classify a revoked Gateway as recoverable infrastructure debt", async () => {
    const f = fixture();
    f.params.assertCurrent.mockImplementation(() => {
      throw new SqliteWorkerError("Owner retired", "closed");
    });
    await expect(dispatchQuestionContinuation(f.params)).rejects.toThrow("Owner retired");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});

describe("write-only terminal receipt persistence", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["interruption", "unknown-claim", "unknown-not-committed", "block"] as const)(
    "retains %s debt through a persistent outage without repeating execution",
    async (kind) => {
      const f = fixture();
      let canonical = f.saved;
      let available = true;
      const release = vi.fn();
      state.restore.mockResolvedValue(
        kind === "block" ? undefined : { authority: f.authority, release },
      );
      state.operate.mockImplementation(async (_scope, op) => {
        if (!available) {
          throw new SqliteWorkerError("Receipt unavailable", "unavailable");
        }
        if (op.kind === "get") {
          return canonical;
        }
        if (op.kind === "claim") {
          if (kind === "unknown-not-committed") {
            available = false;
            throw new SqliteWorkerError("Claim outcome unknown", "outcome-unknown");
          }
          canonical = {
            ...canonical,
            continuation: { status: "claimed", runId: op.runId, gatewayEpoch: op.gatewayEpoch },
          };
          if (kind === "unknown-claim") {
            available = false;
            throw new SqliteWorkerError("Claim ACK lost", "outcome-unknown");
          }
        } else if (op.kind === "finish") {
          expect(op.interrupted).toBe(true);
          canonical = {
            ...canonical,
            continuation: { ...canonical.continuation, status: "interrupted", reason: op.reason },
          };
        } else if (op.kind === "block") {
          canonical = { ...canonical, continuation: { status: "blocked", reason: op.reason } };
        }
        return canonical;
      });
      if (kind === "block") {
        state.restore.mockImplementation(async () => {
          available = false;
          return undefined;
        });
      }
      f.dispatch.mockImplementation(async (request, options) => {
        if (!options.commitAdmission) {
          throw new Error("Missing native claim");
        }
        await options.commitAdmission({
          runId: request.idempotencyKey,
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/tmp/fixture.db",
          lifecycleGeneration: "epoch",
          assertCurrent() {},
        });
        available = false;
        throw new Error("Native execution interrupted");
      });
      const receipt = await dispatchQuestionContinuation(f.params);
      expect(receipt).toMatchObject({ status: "terminal_owed" });
      if (!("repair" in receipt)) {
        throw new Error("Missing write-only terminal obligation");
      }
      expect(release).toHaveBeenCalledTimes(kind === "block" ? 0 : 1);
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const owner = createQuestionCompletionReceipts({ scheduler, warn: vi.fn() });
      try {
        owner.offer(receipt);
        await clock.advanceBy(1_000);
        await clock.advanceBy(2_000);
        const dispatches = f.dispatch.mock.calls.length;
        available = true;
        await clock.advanceBy(4_000);
        expect(canonical.continuation.status).toBe(
          kind === "block" || kind === "unknown-not-committed" ? "blocked" : "interrupted",
        );
        expect(f.dispatch).toHaveBeenCalledTimes(dispatches);
        expect(f.dispatch).toHaveBeenCalledTimes(kind === "block" ? 0 : 1);
        expect(clock.armedAtMs).toBeNull();
      } finally {
        owner.beginClose();
        await owner.stop();
        await scheduler.stop();
      }
    },
  );
});

describe("unknown claim terminal reconciliation ownership", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["lost-ack", "foreign", "retired", "close"] as const)(
    "repairs %s without replay or retiring a healthy winner",
    async (outcome) => {
      const f = fixture();
      let canonical = f.saved;
      let available = true;
      let retired = false;
      let ackLost = false;
      state.operate.mockImplementation(async (_scope, op) => {
        if (retired) {
          throw new SessionQuestionCustodyRetiredError("Physical replacement");
        }
        if (!available) {
          throw new SqliteWorkerError("Unavailable", "unavailable");
        }
        if (op.kind === "get") {
          return canonical;
        }
        if (op.kind === "claim") {
          canonical = {
            ...canonical,
            continuation: { status: "claimed", runId: op.runId, gatewayEpoch: op.gatewayEpoch },
          };
          available = false;
          throw new SqliteWorkerError("Claim ACK lost", "outcome-unknown");
        }
        if (op.kind !== "finish") {
          throw new Error("Foreign winner must never be overwritten");
        }
        canonical = {
          ...canonical,
          continuation: { ...canonical.continuation, status: "interrupted", reason: op.reason },
        };
        if (!ackLost) {
          ackLost = true;
          throw new SqliteWorkerError("Finish ACK lost", "outcome-unknown");
        }
        return canonical;
      });
      f.dispatch.mockImplementation(async (request, options) => {
        if (!options.commitAdmission) {
          throw new Error("Missing native claim");
        }
        await options.commitAdmission({
          runId: request.idempotencyKey,
          sessionId: "session",
          sessionKey: "agent:main:test",
          storePath: "/tmp/fixture.db",
          lifecycleGeneration: "epoch",
          assertCurrent() {},
        });
        throw new Error("Unknown claim cannot execute");
      });
      const receipt = await dispatchQuestionContinuation(f.params);
      expect(receipt).toMatchObject({ status: "terminal_owed" });
      if (!("repair" in receipt)) {
        throw new Error("Missing terminal receipt");
      }
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const notified = vi.fn(async () => {});
      const onRetired = vi.fn();
      const owner = createQuestionCompletionReceipts({ scheduler, warn: vi.fn() });
      try {
        owner.offer(receipt, notified, onRetired);
        if (outcome === "foreign") {
          canonical = {
            ...canonical,
            continuation: { status: "claimed", runId: "winner", gatewayEpoch: "epoch" },
          };
        }
        if (outcome === "retired") {
          retired = true;
        }
        if (outcome === "close") {
          owner.beginClose();
        }
        available = true;
        await clock.advanceBy(1_000);
        await clock.advanceBy(2_000);
        expect(f.dispatch).toHaveBeenCalledOnce();
        expect(onRetired).toHaveBeenCalledTimes(outcome === "retired" ? 1 : 0);
        expect(notified).toHaveBeenCalledTimes(
          outcome === "foreign" || outcome === "lost-ack" ? 1 : 0,
        );
        expect(state.operate.mock.calls.filter(([, op]) => op.kind === "finish")).toHaveLength(
          outcome === "lost-ack" ? 1 : 0,
        );
        expect(clock.armedAtMs).toBeNull();
      } finally {
        owner.beginClose();
        await owner.stop();
        await scheduler.stop();
      }
    },
  );
});
