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
const channelDelivery = {
  restartRecoveryDeliveryRunId: "old-channel-claim",
  restartRecoveryDeliverySourceRunId: "old-channel-source",
};
const interruptedDelivery = {
  restartRecoveryDeliveryRunId: "interrupted-claim",
  restartRecoveryDeliverySourceRunId: "interrupted-source",
};
const recoveryRun = (runId: string) => ({
  runId,
  lifecycleGeneration: getAgentEventLifecycleGeneration(),
});
const disposals: (() => Promise<void>)[] = [];
function deferred() {
  const gate = createDeferred();
  disposals.unshift(async () => gate.resolve());
  return gate;
}
afterEach(async () => {
  for (const dispose of disposals.splice(0)) {
    await dispose();
  }
  testing.resetSessionControllerForTest();
  vi.restoreAllMocks();
});
function createRecoveryGatewayContext(storePath?: string) {
  const recoveryRuntime: GatewayRecoveryRuntime = {
    prepareFailedWorkerPlacement: async () => undefined,
    prepareRestartRecovery: () => undefined,
    resumeChatInput: async () => {
      throw new Error("Unexpected chat input recovery");
    },
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
function owned(result: Admission | undefined) {
  expect(result?.status).toBe("owned");
  if (result?.status !== "owned") {
    throw new Error("Fixture requires an admitted reply operation");
  }
  return result;
}
function observe(pending: Promise<Admission>) {
  const outcome: { result?: Admission; failure?: unknown } = {};
  return Object.assign(outcome, {
    settled: pending.then(
      (result) => (outcome.result = result),
      (failure: unknown) => (outcome.failure = failure),
    ),
  });
}
const beforeSettlement = (
  gate: Promise<unknown>,
  pending: Promise<unknown>,
  signal: AbortSignal,
  message: string,
) => withinTest(awaitGateBeforeSettlement(gate, pending, message), signal);
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
  const pending: ReturnType<typeof observe>[] = [];
  const cleanup: (() => void | Promise<void>)[] = [];
  disposals.push(async () => {
    abort.abort();
    for (const release of cleanup) {
      await release();
    }
    pending.forEach(({ result }) => complete(result));
    for (const admission of pending) {
      await admission.settled;
      complete(admission.result);
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
    pending.push(observe(admission));
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
    operation: (request: Partial<Parameters<typeof createReplyOperation>[0]> = {}) => {
      const operation = createReplyOperation({
        sessionKey,
        sessionId,
        resetTriggered: false,
        target: captureSessionTarget({ storeScope: storePath, sessionKey, incarnation: sessionId }),
        ...request,
      });
      cleanup.push(() => operation.complete());
      return operation;
    },
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
    done: (replacement = sessionId, changes: Partial<SessionEntry> = {}) =>
      replaceSessionEntry(
        { storePath, sessionKey },
        { sessionId: replacement, updatedAt: Date.now(), status: "done", ...changes },
      ),
  };
}

function cycle(chargedAttempts: number): NonNullable<SessionEntry["mainRestartRecovery"]> {
  return { cycleId: "cycle-1", revision: 1, chargedAttempts };
}
function fencedRecovery(
  runId = "admitted-recovery",
  chargedAttempts = 1,
  overrides: Partial<SessionEntry> = {},
) {
  return recoveryFixture({
    status: undefined,
    abortedLastRun: false,
    mainRestartRecovery: cycle(chargedAttempts),
    restartRecoveryRuns: [recoveryRun(runId)],
    ...overrides,
  });
}
function observeRecoveryClaim(pause: boolean | string = false) {
  const claimed = deferred();
  const release = deferred();
  const claim = recoveryStore.claimMainSessionRecoveryOwner;
  const spy = vi
    .spyOn(recoveryStore, "claimMainSessionRecoveryOwner")
    .mockImplementation(async (params) => {
      const result = await claim(params);
      if (pause === false || pause === true || params.runId === pause) {
        claimed.resolve();
        if (pause !== false) {
          await release.promise;
        }
      }
      return result;
    });
  return { claimed: claimed.promise, release: () => release.resolve(), spy };
}

it("keeps new input and followups behind a concurrent recovery winner", async () => {
  const f = recoveryFixture({
    ...channelDelivery,
    restartRecoveryDeliveryContext: { channel: "discord", to: "synthetic-channel" },
    restartRecoverySourceIngress: "channel",
  });
  const context = createRecoveryGatewayContext();
  const selected = await f.claim();
  const recoveryStarted = deferred();
  let recovered: ReturnType<typeof createReplyOperation> | undefined;
  let recoveryClaim: SessionControllerMailboxClaim | undefined;
  f.cleanup.unshift(() => {
    recovered?.complete();
    if (recoveryClaim) {
      releaseSessionControllerClaim(recoveryClaim);
    }
  });
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
      recovered = f.operation({ mailboxClaim: recoveryClaim });
      await f.write({
        ...f.entry,
        abortedLastRun: false,
        restartRecoveryRuns: [recoveryRun("old-channel-claim")],
      });
      recoveryStarted.resolve();
      return { started: 1, settled: 0, failed: 0, skipped: 0 };
    });
  const pending = observe(
    f.admit({ mailboxClaim: selected, resolveGatewayContext: () => context }),
  );
  await recoveryStarted.promise;
  await setImmediate();
  expect(pending.result).toBeUndefined();
  expect(pending.failure).toBeUndefined();
  expect(retry).toHaveBeenCalledOnce();
  expect(recoveryClaim?.mailbox.claim).toBe(recoveryClaim);
  await f.done();
  recovered?.complete();
  if (recoveryClaim) {
    releaseSessionControllerClaim(recoveryClaim);
  }
  await pending.settled;
  expect(pending.failure).toBeUndefined();
  const visible = owned(pending.result);
  expect(selected.mailbox.claim).toBe(selected);
  expect(visible.operation).not.toBe(recovered);
  complete(visible);
  expect(retry).toHaveBeenCalledOnce();
});

it.each([
  { kind: "queued_followup", failed: false },
  { kind: "visible", failed: true },
] as const)(
  "settles or defers $kind input according to recovery failure: $failed",
  async ({ kind, failed }) => {
    const f = recoveryFixture(interruptedDelivery);
    const context = createRecoveryGatewayContext();
    const retryEntered = deferred();
    const retry = vi
      .spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery")
      .mockImplementation(async () => {
        retryEntered.resolve();
        return { started: 0, settled: 0, failed: failed ? 1 : 0, skipped: failed ? 0 : 1 };
      });
    const outcome = f.wait({ resolveGatewayContext: () => context, kind });
    await awaitGateBeforeSettlement(
      retryEntered.promise,
      outcome.settled,
      "Admission settled before recovery dispatch",
    );
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

it.each(
  (["startup", "admitted"] as const).flatMap((owner) =>
    (["completed", "cancelled", "replaced"] as const).map((outcome) => ({ owner, outcome })),
  ),
)("keeps visible input behind $owner recovery until $outcome", async ({ owner, outcome }) => {
  const f =
    owner === "startup"
      ? recoveryFixture({
          mainRestartRecovery: {
            ...cycle(1),
            reservation: { ...recoveryRun("startup-recovery"), attempt: 1 },
          },
        })
      : fencedRecovery();
  const selected = await f.claim();
  const startup =
    owner === "startup"
      ? f.reserve(
          "followup",
          resolveRestartResendReservationId({ sessionId, cycleId: "cycle-1", attempt: 1 }),
        )
      : undefined;
  const predecessor = owner === "admitted" ? await f.begin() : undefined;
  const stored = f.read();
  const attempted = owner === "admitted" ? observeRecoveryClaim().claimed : undefined;
  const retry = vi.spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery");
  const context = createRecoveryGatewayContext(owner === "admitted" ? f.storePath : undefined);
  const admission = f.wait({
    mailboxClaim: selected,
    resolveGatewayContext: () => context,
    waitForActive: false,
  });
  if (owner === "startup") {
    await vi.waitFor(() => expect(selected.mailbox.claim).toBeUndefined());
    expect(retry).not.toHaveBeenCalled();
  } else {
    await attempted;
    await setImmediate();
    expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
    expect(f.read()).toEqual(stored);
  }
  expect(admission.result).toBeUndefined();
  expect(admission.failure).toBeUndefined();
  if (outcome === "cancelled") {
    f.abort.abort();
  } else {
    await f.done(
      outcome === "replaced" ? "replacement-session" : sessionId,
      owner === "startup" ? { abortedLastRun: false } : {},
    );
    if (startup) {
      retireSessionControllerInput(startup);
    }
  }
  predecessor?.release();
  await admission.settled;
  if (outcome === "replaced") {
    expect(admission.failure).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    if (owner === "admitted") {
      expect(admission.result).toBeUndefined();
    }
  } else {
    expect(admission.failure).toBeUndefined();
    expect(admission.result).toMatchObject(
      outcome === "completed" ? { status: "owned" } : { status: "skipped", reason: "aborted" },
    );
  }
  if (owner === "startup") {
    expect(retry).not.toHaveBeenCalled();
  }
});

it("queues detached followups behind direct commands without a reply operation", async ({
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

it("rejects command adoption without waiting behind a live recovery fence", async () => {
  const f = fencedRecovery("active-run", 0);
  const context = createRecoveryGatewayContext(f.storePath);
  await f.begin();
  const blocker = f.operation();
  blocker.setPhase("running");
  const sourceKey = "agent:main:discord:slash:source";
  const reservation = f.operation({
    sessionKey: sourceKey,
    sessionId: "source-session",
    target: undefined,
  });
  bindGatewayContextResolver(reservation, () => context);
  const before = f.read();
  const attempted = observeRecoveryClaim().claimed;
  const admission = f.wait({
    sessionId: reservation.sessionId,
    waitForActive: false,
    adoptOperation: reservation,
  });
  await attempted;
  await setImmediate();
  expect(admission.failure).toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
  expect(admission.result).toBeUndefined();
  expect(getSessionControllerOperation(sessionKey)).toBe(blocker);
  expect(getSessionControllerOperation(sourceKey)).toBe(reservation);
  expect(reservation.key).toBe(sourceKey);
  expect(reservation.result).toBeNull();
  expect(f.read()).toEqual(before);
});

it("reconciles an orphaned recovery fence before admitting channel input", async () => {
  const f = fencedRecovery("admitted-recovery", 1, channelDelivery);
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
      await f.done();
      return { started: 1, settled: 0, failed: 0, skipped: 0 };
    });
  const selected = await f.claim();
  owned(await f.admit({ mailboxClaim: selected, resolveGatewayContext: () => context }));
  expect(selected.mailbox.claim).toBe(selected);
  expect(retry).toHaveBeenCalledOnce();
});

it("admits the next room message after a live stop without restart recovery", async () => {
  // openclaw#1468: a stop leaves a killed outcome beside its message-tool-only claim.
  const f = recoveryFixture({
    status: "killed",
    restartRecoveryDeliveryRunId: "stopped-run",
    restartRecoverySourceIngress: "channel",
    restartRecoverySourceReplyDeliveryMode: "message_tool_only",
    restartRecoveryDeliveryContext: { channel: "discord", to: "discord:channel:room" },
  });
  const context = createRecoveryGatewayContext(f.storePath);
  const retry = vi.spyOn(restartRecovery, "retryRestartAbortedMainSessionRecovery");
  const selected = await f.claim();
  owned(await f.admit({ mailboxClaim: selected, resolveGatewayContext: () => context }));
  expect(retry).not.toHaveBeenCalled();
  expect(context.recoveryRuntime?.sendRecoveryNotice).not.toHaveBeenCalled();
  expect(f.read()).toMatchObject({
    status: "killed",
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "stopped-run",
  });
  expect(f.read()?.mainRestartRecovery).toBeUndefined();
});

it("revalidates channel authority before reclaiming orphaned recovery", async ({ signal }) => {
  const f = fencedRecovery("admitted-recovery", 1, channelDelivery);
  const selected = await f.claim();
  const context = createRecoveryGatewayContext(f.storePath);
  const before = f.read();
  const marking = deferred();
  const release = deferred();
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
  await beforeSettlement(marking.promise, admission.settled, signal, "Recovery skipped its owner");
  current = false;
  release.resolve();
  await withinTest(admission.settled, signal);
  expect(admission.failure).toMatchObject({ message: "Channel authority revoked" });
  expect(admission.result).toBeUndefined();
  expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
  expect(f.read()).toEqual(before);
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
  const fence = [recoveryRun("busy-reply")];
  if (withRecoveryFence) {
    await fixture.write({
      ...fixture.entry,
      restartRecoveryRuns: fence,
      restartRecoveryDeliveryRunId: "busy-reply",
    });
  }
  const commands: Promise<unknown>[] = [];
  type Command = Parameters<typeof runWithAgentCommandRecoveryOwner<typeof target, string>>[0];
  disposals.unshift(async () => {
    fixture.abort.abort();
    reply.operation.complete();
    await Promise.allSettled(commands);
    await replyReleased;
  });
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
  };
}

it.for(["recovery fence", "worker-owned input"] as const)(
  "keeps two accepted commands in FIFO order behind a reply with %s",
  async (ownership, { signal }) => {
    const fixture = await busyReply(ownership === "recovery fence");
    const releaseFirst = deferred();
    const firstStarted = deferred();
    const order: string[] = [];
    const claim = vi.spyOn(recoveryStore, "claimMainSessionRecoveryOwner");
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
  },
);

it.for(["cancelled", "retained fence"] as const)(
  "does not execute the waiting command after %s",
  async (outcome, { signal }) => {
    const fixture = await busyReply();
    const run = vi.fn(async () => "ran");
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
  },
);

it("keeps a successor behind an acquired turn's delayed durable claim", async ({ signal }) => {
  const fixture = await busyReply();
  const claim = observeRecoveryClaim("racing");
  const run = vi.fn(async () => "ran");
  const command = fixture.command("racing", { run });
  await vi.waitFor(() => expect(fixture.queued()).toBe(1));
  await fixture.finish();
  await beforeSettlement(claim.claimed, command, signal, "Command skipped its durable claim");
  const successor = fixture.command("successor", { run });
  await vi.waitFor(() => expect(fixture.queued()).toBe(2));
  expect(run).not.toHaveBeenCalled();
  claim.release();
  await expect(withinTest(Promise.all([command, successor]), signal)).resolves.toEqual([
    "ran",
    "ran",
  ]);
  expect(run).toHaveBeenCalledTimes(2);
});

it("returns the foreground recovery claim and releases it when visible reply work clears", async () => {
  const f = recoveryFixture({ mainRestartRecovery: cycle(2) });
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

it("settles committed recovery without replay after preparation changes", async ({ signal }) => {
  const f = recoveryFixture({ mainRestartRecovery: cycle(0) });
  const predecessor = f.operation();
  const claim = observeRecoveryClaim(true);
  const pending = f.admit({ expectedSessionId: undefined });
  await beforeSettlement(
    claim.claimed,
    pending,
    signal,
    "Admission completed before recovery claimed ownership",
  );
  expect(f.read()?.mainRestartRecovery).toMatchObject({
    foregroundClaims: { tokens: [expect.any(String)] },
  });
  predecessor.complete();
  claim.release();
  await expect(withinTest(pending, signal)).rejects.toMatchObject({
    code: "SESSION_WORK_START_CHANGED",
  });
  expect(claim.spy).toHaveBeenCalledOnce();
  expect(f.read()?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
});

it("hands an interrupt to ordinary recovery ownership when the owed resend cannot be retired", async () => {
  const f = recoveryFixture({
    ...interruptedDelivery,
    mainRestartRecovery: {
      ...cycle(1),
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

it("preserves unsettled recovery delivery custody while refusing a queued followup", async () => {
  const f = recoveryFixture({
    abortedLastRun: false,
    restartRecoveryDeliveryRunId: "completed-recovery",
    restartRecoveryRuns: [recoveryRun("completed-recovery")],
  });
  const mailboxClaim = await f.claim();
  const result = await f.admit({ mailboxClaim, kind: "queued_followup" });
  // A delivery ID and nonterminal fence retain custody even after the abort flag clears.
  expect(result).toMatchObject({ status: "skipped", reason: "lifecycle-invalidated" });
  expect(f.read()).toMatchObject(f.entry);
  expect(f.read()?.mainRestartRecovery).toBeUndefined();
});
