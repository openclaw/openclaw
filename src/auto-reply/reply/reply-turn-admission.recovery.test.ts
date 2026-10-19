import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { runWithAgentCommandRecoveryOwner } from "../../agents/agent-command-recovery-owner.js";
import * as recoveryStore from "../../agents/main-session-recovery/main-session-recovery-store.js";
import * as recoveryMarking from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { resolveRestartResendReservationId } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import * as restartRecovery from "../../agents/main-session-recovery/main-session-restart-recovery.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import {
  createReplyOperation,
  getSessionControllerOperation,
} from "../../sessions/session-controller.js";
import {
  beginSessionEffect,
  captureSessionControllerSettlement,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  type SessionControllerMailboxClaim,
} from "../../sessions/session-controller.mailbox.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { admitTestReplyTurn, createSessionStore } from "./reply-turn-admission.test-support.js";

type Admission = Awaited<ReturnType<typeof admitTestReplyTurn>>;
const sessionKey = "agent:main:main";
const sessionId = "interrupted-session";
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) {
    await dispose();
  }
  testing.resetSessionControllerForTest();
  vi.restoreAllMocks();
});
function createRecoveryGatewayContext(storePath?: string) {
  const recoveryRuntime: GatewayRecoveryRuntime = {
    prepareRestartRecovery: () => undefined,
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: vi.fn(),
    waitForAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(),
  };
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = () => (storePath ? { session: { store: storePath } } : {});
  context.recoveryRuntime = recoveryRuntime;
  context.workerSessionPlacementService = { getMany: () => new Map() };
  return context;
}
function complete(result: Admission | undefined) {
  if (result?.status === "owned") {
    result.operation.complete();
  }
}
function owned(result: Admission) {
  expect(result.status).toBe("owned");
  if (result.status !== "owned") {
    throw new Error("Fixture requires an admitted reply operation");
  }
  return result;
}
function observe(pending: Promise<Admission>) {
  const outcome: { result?: Admission; failure?: unknown } = {};
  const settled = pending.then(
    (result) => {
      outcome.result = result;
    },
    (failure: unknown) => {
      outcome.failure = failure;
    },
  );
  return Object.assign(outcome, { settled });
}
function recoveryFixture(overrides: Partial<SessionEntry> = {}) {
  const entry: SessionEntry = {
    sessionId,
    updatedAt: 100,
    status: "interrupted",
    abortedLastRun: true,
    ...overrides,
  };
  const storePath = createSessionStore({ [sessionKey]: entry });
  const scope = { scope: storePath, identities: [sessionKey, sessionId] };
  const abort = new AbortController();
  const pending: Promise<Admission>[] = [];
  const results: Admission[] = [];
  const cleanup: (() => void | Promise<void>)[] = [];
  disposals.push(async () => {
    abort.abort();
    for (const release of cleanup) {
      await release();
    }
    results.forEach(complete);
    for (const admission of pending) {
      complete(await admission.catch(() => undefined));
    }
  });
  const admit = (request: Partial<Parameters<typeof admitTestReplyTurn>[0]> = {}) => {
    const admission = admitTestReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      ...request,
    });
    pending.push(admission);
    void admission.then(
      (result) => results.push(result),
      () => {},
    );
    return admission;
  };
  const reserve = (policy: "followup" | "interrupt" = "followup", reservationId?: string) => {
    const input = reserveSessionControllerSource(sessionKey, {
      reservationId,
      policy: { mode: policy },
      target: captureSessionTarget({ storeScope: storePath, sessionKey, incarnation: sessionId }),
      adapter: { signal: abort.signal },
    });
    cleanup.push(async () => {
      input.claim?.operation?.complete();
      if (input.claim) {
        releaseSessionControllerClaim(input.claim);
        await input.claim.settlement.promise;
      } else {
        retireSessionControllerInput(input);
        await input.settlement.promise;
      }
    });
    return input;
  };
  const claim = async (policy: "followup" | "interrupt" = "followup") =>
    await claimSessionControllerTask(reserve(policy), () => {});
  return {
    entry,
    storePath,
    scope,
    abort,
    cleanup,
    admit,
    reserve,
    claim,
    begin: async () => {
      const effect = await beginSessionEffect({ ...scope, assertAllowed: () => {} });
      cleanup.push(async () => {
        effect.release();
        await effect.released;
      });
      return effect;
    },
    wait: (request: Parameters<typeof admit>[0]) =>
      observe(admit({ upstreamAbortSignal: abort.signal, ...request })),
    read: () => loadSessionEntry({ storePath, sessionKey }),
    write: (value: SessionEntry) => replaceSessionEntry({ storePath, sessionKey }, value),
  };
}

it("keeps new input and followups behind a concurrent recovery winner", async () => {
  const delivery = {
    restartRecoveryDeliveryRunId: "old-channel-claim",
    restartRecoveryDeliverySourceRunId: "old-channel-source",
  };
  const f = recoveryFixture({
    ...delivery,
    restartRecoveryDeliveryContext: { channel: "discord", to: "synthetic-channel" },
    restartRecoverySourceIngress: "channel",
  });
  const context = createRecoveryGatewayContext();
  const selected = await f.claim();
  const recoveryStarted = createDeferred();
  let recovered: ReturnType<typeof createReplyOperation> | undefined;
  let recoveryClaim: SessionControllerMailboxClaim | undefined;
  const retry = vi
    .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
    .mockImplementationOnce(async (request) => {
      expect(request).toMatchObject({
        expectedSessionId: sessionId,
        expectedRecoveryRunId: "old-channel-claim",
        lane: "main",
        expectedRecoverySourceRunId: "old-channel-source",
        gatewayRuntime: context.recoveryRuntime,
      });
      const input = request.controllerInput;
      if (!input) {
        throw new Error("Recovery must receive the selected claim's predecessor");
      }
      input.custody.rpcAdopted = true;
      recoveryClaim = await claimSessionControllerTask(input, () => {});
      recovered = createReplyOperation({
        sessionKey,
        sessionId,
        resetTriggered: false,
        mailboxClaim: recoveryClaim,
        target: captureSessionTarget({
          storeScope: f.storePath,
          sessionKey,
          incarnation: sessionId,
        }),
      });
      await f.write({
        ...f.entry,
        abortedLastRun: false,
        restartRecoveryRuns: [
          {
            runId: "old-channel-claim",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        ],
      });
      recoveryStarted.resolve();
      return { started: 1, settled: 0, failed: 0, skipped: 0 };
    });
  let settled = false;
  const pending = f
    .admit({ mailboxClaim: selected, resolveGatewayContext: () => context })
    .finally(() => {
      settled = true;
    });
  try {
    await recoveryStarted.promise;
    await setImmediate();
    expect(settled).toBe(false);
    expect(retry).toHaveBeenCalledOnce();
    expect(recoveryClaim?.mailbox.claim).toBe(recoveryClaim);
    await f.write({ sessionId, updatedAt: Date.now(), status: "done" });
    recovered?.complete();
    if (recoveryClaim) {
      releaseSessionControllerClaim(recoveryClaim);
    }
    const visible = owned(await pending);
    expect(selected.mailbox.claim).toBe(selected);
    expect(visible.operation).not.toBe(recovered);
    complete(visible);
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    recovered?.complete();
    if (recoveryClaim) {
      releaseSessionControllerClaim(recoveryClaim);
    }
  }
});

it.each([
  { kind: "queued_followup", failed: false },
  { kind: "visible", failed: true },
] as const)(
  "settles or defers $kind input according to recovery failure: $failed",
  async ({ kind, failed }) => {
    const f = recoveryFixture({
      restartRecoveryDeliveryRunId: "interrupted-claim",
      restartRecoveryDeliverySourceRunId: "interrupted-source",
    });
    const context = createRecoveryGatewayContext();
    const retryEntered = createDeferred();
    const retry = vi
      .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
      .mockImplementation(async () => {
        retryEntered.resolve();
        return { started: 0, settled: 0, failed: failed ? 1 : 0, skipped: failed ? 0 : 1 };
      });
    const outcome = f.wait({ resolveGatewayContext: () => context, kind });
    await Promise.race([
      retryEntered.promise,
      outcome.settled.then(() => {
        throw new Error("Admission settled before recovery dispatch");
      }),
    ]);
    expect(retry).toHaveBeenCalledOnce();
    expect(retry.mock.calls[0]?.[0].lane).toBe(kind === "visible" ? "main" : undefined);
    await setImmediate();
    expect(f.read()).toMatchObject(f.entry);
    expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
    if (failed) {
      await outcome.settled;
      expect(outcome.failure).toMatchObject({
        message: expect.stringMatching(/restart recovery failed/i),
      });
      expect(outcome.result).toBeUndefined();
    } else {
      expect(outcome.failure).toBeUndefined();
      await outcome.settled;
      expect(outcome.result).toEqual({ status: "skipped", reason: "active-run" });
    }
    expect(retry).toHaveBeenCalledOnce();
  },
);

it.each(["started", "cancelled", "replaced"] as const)(
  "joins reserved startup recovery before selected visible input: %s",
  async (outcome) => {
    const f = recoveryFixture({
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 1,
        reservation: {
          runId: "startup-recovery",
          attempt: 1,
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
        },
      },
    });
    const selected = await f.claim();
    const startup = f.reserve(
      "followup",
      resolveRestartResendReservationId({
        sessionId,
        cycleId: "cycle-1",
        attempt: 1,
      }),
    );
    const retry = vi.spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery");
    const context = createRecoveryGatewayContext();
    const admission = f.wait({
      mailboxClaim: selected,
      resolveGatewayContext: () => context,
      waitForActive: false,
    });
    await vi.waitFor(() => expect(selected.mailbox.claim).toBeUndefined());
    expect(admission.result).toBeUndefined();
    expect(admission.failure).toBeUndefined();
    expect(retry).not.toHaveBeenCalled();
    if (outcome === "cancelled") {
      f.abort.abort();
    } else {
      await f.write({
        sessionId: outcome === "replaced" ? "replacement-session" : sessionId,
        updatedAt: Date.now(),
        abortedLastRun: false,
        status: "done",
      });
      retireSessionControllerInput(startup);
    }
    await admission.settled;
    if (outcome === "replaced") {
      expect(admission.failure).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    } else {
      expect(admission.failure).toBeUndefined();
      expect(admission.result).toMatchObject(
        outcome === "started" ? { status: "owned" } : { status: "skipped", reason: "aborted" },
      );
    }
    expect(retry).not.toHaveBeenCalled();
  },
);

it("keeps a detached followup behind a selected direct command without a reply operation", async ({
  signal,
}) => {
  const f = recoveryFixture({ status: undefined, abortedLastRun: undefined });
  const command = await f.claim();
  const input = f.reserve();
  const selected = vi.fn();
  const pending = claimSessionControllerTask(input, selected, "queued_followup");
  expect(input.phase).toBe("waiting");
  expect(selected).not.toHaveBeenCalled();
  expect(input.mailbox.owner.active).toBeUndefined();
  releaseSessionControllerClaim(command);
  const mailboxClaim = await withinTest(pending, signal);
  expect(selected).toHaveBeenCalledExactlyOnceWith(mailboxClaim);
  const result = await withinTest(f.admit({ mailboxClaim, kind: "queued_followup" }), signal);
  expect(result).toMatchObject({ status: "owned" });
});

it("does not consume startup recovery's source while monitoring", async () => {
  const f = recoveryFixture({ status: undefined, abortedLastRun: undefined });
  const startup = f.reserve();
  const result = await f.admit({ kind: "heartbeat" });
  expect(result).toMatchObject({ status: "skipped", reason: "active-run" });
  expect(startup.phase).toBe("preparing");
  expect(startup.retirementRequested).toBeFalsy();
  expect(f.read()?.sessionId).toBe(sessionId);
});

it.each(["settled", "cancelled", "replaced"] as const)(
  "keeps visible input behind an admitted recovery fence until %s",
  async (outcome) => {
    const f = recoveryFixture({
      status: undefined,
      abortedLastRun: false,
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 1 },
      restartRecoveryRuns: [
        { runId: "admitted-recovery", lifecycleGeneration: getAgentEventLifecycleGeneration() },
      ],
    });
    const selected = await f.claim();
    const predecessor = await f.begin();
    const stored = f.read();
    const attempted = createDeferred();
    const claim = recoveryStore.claimMainSessionRecoveryOwner;
    vi.spyOn(recoveryStore, "claimMainSessionRecoveryOwner").mockImplementation(async (params) => {
      const result = await claim(params);
      attempted.resolve();
      return result;
    });
    const context = createRecoveryGatewayContext(f.storePath);
    const admission = f.wait({
      mailboxClaim: selected,
      resolveGatewayContext: () => context,
      waitForActive: false,
    });
    await attempted.promise;
    await setImmediate();
    expect(admission.failure).toBeUndefined();
    expect(admission.result).toBeUndefined();
    expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
    expect(f.read()).toEqual(stored);
    if (outcome === "cancelled") {
      f.abort.abort();
    } else {
      await f.write({
        sessionId: outcome === "replaced" ? "replacement-session" : sessionId,
        updatedAt: Date.now(),
        status: "done",
      });
    }
    predecessor.release();
    await admission.settled;
    if (outcome === "replaced") {
      expect(admission.failure).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
      expect(admission.result).toBeUndefined();
    } else {
      expect(admission.failure).toBeUndefined();
      expect(admission.result).toMatchObject(
        outcome === "settled" ? { status: "owned" } : { status: "skipped", reason: "aborted" },
      );
    }
  },
);

it("rejects command adoption without waiting behind a live recovery fence", async () => {
  const f = recoveryFixture({
    status: undefined,
    abortedLastRun: false,
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    restartRecoveryRuns: [
      { runId: "active-run", lifecycleGeneration: getAgentEventLifecycleGeneration() },
    ],
  });
  const context = createRecoveryGatewayContext(f.storePath);
  await f.begin();
  const blocker = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
    target: captureSessionTarget({ storeScope: f.storePath, sessionKey, incarnation: sessionId }),
  });
  blocker.setPhase("running");
  const sourceKey = "agent:main:discord:slash:source";
  const reservation = createReplyOperation({
    sessionKey: sourceKey,
    sessionId: "source-session",
    resetTriggered: false,
  });
  bindGatewayContextResolver(reservation, () => context);
  f.cleanup.push(
    () => blocker.complete(),
    () => reservation.complete(),
  );
  const before = f.read();
  const attempted = createDeferred();
  const claim = recoveryStore.claimMainSessionRecoveryOwner;
  vi.spyOn(recoveryStore, "claimMainSessionRecoveryOwner").mockImplementation(async (params) => {
    const result = await claim(params);
    attempted.resolve();
    return result;
  });
  const admission = f.wait({
    sessionId: reservation.sessionId,
    waitForActive: false,
    adoptOperation: reservation,
  });
  await attempted.promise;
  await setImmediate();
  expect(admission.failure).toMatchObject({
    code: "SESSION_WORK_START_CHANGED",
  });
  expect(admission.result).toBeUndefined();
  expect(getSessionControllerOperation(sessionKey)).toBe(blocker);
  expect(getSessionControllerOperation(sourceKey)).toBe(reservation);
  expect(reservation.key).toBe(sourceKey);
  expect(reservation.result).toBeNull();
  expect(f.read()).toEqual(before);
});

it("reconciles an orphaned recovery fence before admitting channel input", async () => {
  const f = recoveryFixture({
    status: undefined,
    abortedLastRun: false,
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 1 },
    restartRecoveryRuns: [
      { runId: "admitted-recovery", lifecycleGeneration: getAgentEventLifecycleGeneration() },
    ],
    restartRecoveryDeliveryRunId: "old-channel-claim",
    restartRecoveryDeliverySourceRunId: "old-channel-source",
  });
  const context = createRecoveryGatewayContext(f.storePath);
  const retry = vi
    .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
    .mockImplementationOnce(async (request) => {
      expect(request.expectedRecoverySourceRunId).toBe("old-channel-source");
      expect(f.read()).toMatchObject({
        sessionId,
        abortedLastRun: true,
        restartRecoveryDeliverySourceRunId: "old-channel-source",
      });
      expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
      await f.write({ sessionId, updatedAt: Date.now(), status: "done" });
      return { started: 1, settled: 0, failed: 0, skipped: 0 };
    });
  const selected = await f.claim();
  owned(await f.admit({ mailboxClaim: selected, resolveGatewayContext: () => context }));
  expect(selected.mailbox.claim).toBe(selected);
  expect(retry).toHaveBeenCalledOnce();
});

it("revalidates channel authority before reclaiming an orphaned recovery fence", async ({
  signal,
}) => {
  const f = recoveryFixture({
    status: undefined,
    abortedLastRun: false,
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 1 },
    restartRecoveryRuns: [
      { runId: "admitted-recovery", lifecycleGeneration: getAgentEventLifecycleGeneration() },
    ],
    restartRecoveryDeliveryRunId: "old-channel-claim",
    restartRecoveryDeliverySourceRunId: "old-channel-source",
  });
  const selected = await f.claim();
  const context = createRecoveryGatewayContext(f.storePath);
  const before = f.read();
  const marking = createDeferred();
  const release = createDeferred();
  const mark = recoveryMarking.markOrphanedMainSessionForRecovery;
  vi.spyOn(recoveryMarking, "markOrphanedMainSessionForRecovery").mockImplementation(
    async (params) => {
      marking.resolve();
      await release.promise;
      return await mark(params);
    },
  );
  let current = true;
  const admission = f.wait({
    mailboxClaim: selected,
    resolveGatewayContext: () => context,
    assertRequestCurrent: () => {
      if (!current) {
        throw new Error("Channel authority revoked");
      }
    },
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(marking.promise, admission.settled, "Recovery skipped its owner"),
      signal,
    );
    current = false;
    release.resolve();
    await withinTest(admission.settled, signal);
    expect(admission.failure).toMatchObject({ message: "Channel authority revoked" });
    expect(admission.result).toBeUndefined();
    expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
    expect(f.read()).toEqual(before);
  } finally {
    release.resolve();
  }
});

async function busyReply(withRecoveryFence = true) {
  const fixture = recoveryFixture({ status: undefined, abortedLastRun: false });
  const reply = owned(await fixture.admit());
  const replyReleased = captureSessionControllerSettlement(fixture.scope);
  if (!replyReleased) {
    throw new Error("Reply admission must retain its lifecycle lease");
  }
  const target = {
    sessionAgentId: "main",
    isNewSession: false,
    sessionId,
    sessionKey,
    storePath: fixture.storePath,
  };
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const fence = [{ runId: "busy-reply", lifecycleGeneration }];
  if (withRecoveryFence) {
    await fixture.write({
      ...fixture.entry,
      restartRecoveryRuns: fence,
      restartRecoveryDeliveryRunId: "busy-reply",
    });
  }
  const commands: Promise<unknown>[] = [];
  type Command = Parameters<typeof runWithAgentCommandRecoveryOwner<typeof target, string>>[0];
  return {
    target,
    controller: fixture.abort,
    fence,
    read: fixture.read,
    finish: async (retainFence = false) => {
      if (!retainFence) {
        await fixture.write({ ...fixture.entry, status: "done" });
      }
      reply.operation.complete();
      await replyReleased;
    },
    queued: () =>
      getSessionControllerEntryForOperation(reply.operation).mailbox?.entries.filter(
        (input) => input.phase !== "consumed",
      ).length ?? 0,
    command: (runId: string, overrides: Partial<Command> = {}) => {
      const command = runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "claim",
        opts: { message: runId, runId, abortSignal: fixture.abort.signal },
        prepare: async () => target,
        run: async () => runId,
        ...overrides,
      });
      commands.push(command);
      void command.catch(() => {});
      return command;
    },
    cleanup: async () => {
      fixture.abort.abort();
      reply.operation.complete();
      await Promise.allSettled(commands);
      await replyReleased;
    },
  };
}

it.for(["recovery fence", "worker-owned input"] as const)(
  "keeps two accepted commands in FIFO order behind a reply with %s",
  async (ownership, { signal }) => {
    const fixture = await busyReply(ownership === "recovery fence");
    const releaseFirst = createDeferred();
    const firstStarted = createDeferred();
    const order: string[] = [];
    const claim = vi.spyOn(recoveryStore, "claimMainSessionRecoveryOwner");
    try {
      const first = fixture.command("first", {
        run: async () => {
          order.push("first");
          firstStarted.resolve();
          await releaseFirst.promise;
          return "first";
        },
      });
      await vi.waitFor(() => expect(fixture.queued()).toBe(1));
      const second = fixture.command("second", {
        run: async () => {
          order.push("second");
          return "second";
        },
      });
      await vi.waitFor(() => expect(fixture.queued()).toBe(2));
      expect(order).toEqual([]);
      expect(claim).not.toHaveBeenCalled();
      await fixture.finish();
      await withinTest(firstStarted.promise, signal);
      expect(order).toEqual(["first"]);
      releaseFirst.resolve();
      await expect(withinTest(Promise.all([first, second]), signal)).resolves.toEqual([
        "first",
        "second",
      ]);
      expect(order).toEqual(["first", "second"]);
    } finally {
      releaseFirst.resolve();
      await fixture.cleanup();
    }
  },
);

it.for(["cancelled", "retained fence"] as const)(
  "does not execute the waiting command after %s",
  async (outcome, { signal }) => {
    const fixture = await busyReply();
    const run = vi.fn(async () => "ran");
    try {
      const command = fixture.command("waiting", { run });
      await vi.waitFor(() => expect(fixture.queued()).toBe(1));
      if (outcome === "cancelled") {
        fixture.controller.abort();
      } else {
        await fixture.finish(true);
      }
      await expect(withinTest(command, signal)).rejects.toMatchObject(
        outcome === "cancelled" ? { name: "AbortError" } : { code: "SESSION_WORK_START_CHANGED" },
      );
      expect(run).not.toHaveBeenCalled();
      expect(fixture.read()?.restartRecoveryRuns).toEqual(fixture.fence);
    } finally {
      await fixture.cleanup();
    }
  },
);

it("keeps a successor behind an acquired turn's delayed durable claim", async ({ signal }) => {
  const fixture = await busyReply();
  const returnClaim = createDeferred();
  const claimed = createDeferred();
  const claim = recoveryStore.claimMainSessionRecoveryOwner;
  vi.spyOn(recoveryStore, "claimMainSessionRecoveryOwner").mockImplementation(async (params) => {
    const result = await claim(params);
    if (params.runId === "racing") {
      claimed.resolve();
      await returnClaim.promise;
    }
    return result;
  });
  const run = vi.fn(async () => "ran");
  try {
    const command = fixture.command("racing", { run });
    await vi.waitFor(() => expect(fixture.queued()).toBe(1));
    await fixture.finish();
    await withinTest(
      awaitGateBeforeSettlement(claimed.promise, command, "Command skipped its durable claim"),
      signal,
    );
    const successor = fixture.command("successor", { run });
    await vi.waitFor(() => expect(fixture.queued()).toBe(2));
    expect(run).not.toHaveBeenCalled();
    returnClaim.resolve();
    await expect(withinTest(Promise.all([command, successor]), signal)).resolves.toEqual([
      "ran",
      "ran",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  } finally {
    returnClaim.resolve();
    await fixture.cleanup();
  }
});

it("returns the foreground recovery claim and releases it when visible reply work clears", async () => {
  const f = recoveryFixture({
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 2 },
  });
  const admission = owned(await f.admit());
  const claimedEntry = f.read();
  complete(admission);
  await vi.waitFor(() => expect(f.read()?.mainRestartRecovery?.foregroundClaims).toBeUndefined());
  expect(claimedEntry?.mainRestartRecovery).toMatchObject({
    foregroundClaims: { tokens: [expect.any(String)] },
  });
  expect(admission.sessionEntry).toMatchObject({
    mainRestartRecovery: { foregroundClaims: claimedEntry?.mainRestartRecovery?.foregroundClaims },
  });
  expect(f.read()).toMatchObject({
    sessionId,
    status: "interrupted",
    abortedLastRun: true,
    mainRestartRecovery: { cycleId: "cycle-1", chargedAttempts: 2 },
  });
});

it("settles a committed recovery claim without replay when preparation changes", async ({
  signal,
}) => {
  const f = recoveryFixture({
    mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
  });
  const predecessor = createReplyOperation({
    sessionKey,
    sessionId,
    resetTriggered: false,
    target: captureSessionTarget({ storeScope: f.storePath, sessionKey, incarnation: sessionId }),
  });
  const claimed = createDeferred();
  const release = createDeferred();
  const claim = recoveryStore.claimMainSessionRecoveryOwner;
  const claimSpy = vi
    .spyOn(recoveryStore, "claimMainSessionRecoveryOwner")
    .mockImplementation(async (params) => {
      const result = await claim(params);
      claimed.resolve();
      await release.promise;
      return result;
    });
  const pending = f.admit({ expectedSessionId: undefined });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        claimed.promise,
        pending,
        "Admission completed before recovery claimed ownership",
      ),
      signal,
    );
    expect(f.read()?.mainRestartRecovery).toMatchObject({
      foregroundClaims: { tokens: [expect.any(String)] },
    });
    predecessor.complete();
    release.resolve();
    await expect(withinTest(pending, signal)).rejects.toMatchObject({
      code: "SESSION_WORK_START_CHANGED",
    });
    expect(claimSpy).toHaveBeenCalledOnce();
    expect(f.read()?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
    expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
  } finally {
    release.resolve();
    predecessor.complete();
    await pending.catch(() => {});
  }
});

it("hands an interrupt to ordinary recovery ownership when the owed resend cannot be retired", async () => {
  const f = recoveryFixture({
    restartRecoveryDeliveryRunId: "interrupted-claim",
    restartRecoveryDeliverySourceRunId: "interrupted-source",
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 1,
      chargedAttempts: 1,
      foregroundClaims: {
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        tokens: ["deferred-release"],
      },
    },
  });
  const mailboxClaim = await f.claim("interrupt");
  const commit = recoveryStore.commitMainSessionRecovery;
  let retirements = 0;
  vi.spyOn(recoveryStore, "commitMainSessionRecovery").mockImplementation(async (params) => {
    if (params.command.kind === "interrupt_owed" && ++retirements > 1) {
      f.abort.abort();
    }
    return await commit(params);
  });
  const admission = owned(await f.admit({ mailboxClaim, upstreamAbortSignal: f.abort.signal }));
  expect(retirements).toBe(1);
  expect(f.read()).toMatchObject({
    abortedLastRun: true,
    status: "interrupted",
    mainRestartRecovery: {
      chargedAttempts: 1,
      foregroundClaims: { tokens: expect.arrayContaining(["deferred-release"]) },
    },
  });
  expect(f.read()?.mainRestartRecovery?.foregroundClaims?.tokens).toHaveLength(2);
  complete(admission);
});

it("preserves settled recovery delivery residue while monitoring", async () => {
  const f = recoveryFixture({
    abortedLastRun: false,
    restartRecoveryDeliveryRunId: "completed-recovery",
    restartRecoveryRuns: [
      { runId: "completed-recovery", lifecycleGeneration: getAgentEventLifecycleGeneration() },
    ],
  });
  const result = owned(await f.admit({ kind: "heartbeat" }));
  expect(f.read()).toMatchObject(f.entry);
  expect(f.read()?.mainRestartRecovery).toBeUndefined();
  complete(result);
});
