import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  updateSessionControllerSourcePolicy,
  getExistingSessionControllerMailbox,
  attachSessionControllerInputOperation,
  beginSessionControllerSourceInjection,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import { createDispatchReplyOperationCoordinator } from "./dispatch-from-config.lifecycle.js";
import { prepareInternalGetReplyOptions } from "./get-reply.types.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import {
  bindReplySourceInput,
  bindReplySourceToFollowup,
  prepareReplySourceInput,
  readReplySourceInput,
  retireUnadoptedReplySource,
  retargetReplySourceForExecution,
} from "./reply-source-binding.js";

afterEach(() => testing.resetSessionControllerForTest());

const key = "agent:main:source-binding";
const target = captureSessionTarget({ storeScope: "/test/source.sqlite", sessionKey: key });
function reserve() {
  return reserveSessionControllerSource(key, { target, policy: { mode: "followup" } });
}
function prepare(
  ctx: string | Parameters<typeof prepareReplySourceInput>[0] = key,
  options?: Parameters<typeof prepareReplySourceInput>[2],
  store = target.storeScope,
) {
  return prepareReplySourceInput(
    typeof ctx === "string" ? { SessionKey: ctx } : ctx,
    { session: { store } },
    options,
  );
}

const nativeContext = (commandTarget: string, sessionKey = key) => ({
  SessionKey: sessionKey,
  CommandSource: "native" as const,
  CommandTargetSessionKey: commandTarget,
});

it("carries the Gateway source through lifecycle/options spreads to the actual followup", async () => {
  const input = reserve();
  const lifecycle: TurnAdoptionLifecycle = bindReplySourceInput({ onAdopted() {} }, input);
  const options = prepareInternalGetReplyOptions({
    turnAdoptionLifecycle: { ...lifecycle, onAdopted: async () => lifecycle.onAdopted() },
  });
  const prepared = await prepare(key, { ...options });
  const run = createQueueTestRun({ prompt: "hello" });
  expect(prepared.created).toBe(false);
  expect(readReplySourceInput(prepared.options)).toBe(input);
  bindReplySourceToFollowup({ ...prepared.options }, run);
  expect(run.controllerInput).toBe(input);
  expect(input.source).toBe(run);
  expect(input.mailbox.entries).toEqual([input]);
  expect(lifecycle).not.toHaveProperty("controllerInput");
  retireSessionControllerInput(input);
});

it("captures physical source rather than native command target before preparation", async () => {
  const source = await prepare(
    { SessionKey: key, CommandTargetSessionKey: "agent:main:other" },
    undefined,
    "/test/actual.sqlite",
  );
  expect(source.input?.mailbox.owner.target).toMatchObject({
    sessionKey: key,
    storeScope: "/test/actual.sqlite",
  });
  const otherStore = await prepare(key, undefined, "/test/other.sqlite");
  expect(otherStore.input?.mailbox).not.toBe(source.input?.mailbox);
  retireUnadoptedReplySource(source.input);
  retireUnadoptedReplySource(otherStore.input);
});

it("moves the native continuation itself, preserving custody and target backlog", async () => {
  const slash = "agent:main:slash";
  const source = await prepare(slash);
  const input = source.input!;
  const { mailbox: previous, instance, custody, settlement } = input;
  const older = reserve();
  retargetReplySourceForExecution({
    ctx: nativeContext(key, slash),
    options: source.options,
    sessionKey: key,
    storePath: "/test/source.sqlite",
    agentId: "main",
  });
  expect(readReplySourceInput(source.options)).toBe(input);
  expect(input.instance).toBe(instance);
  expect(input.custody).toBe(custody);
  expect(input.settlement).toBe(settlement);
  expect(previous.entries).not.toContain(input);
  expect(input.mailbox).toBe(older.mailbox);
  expect(input.mailbox.entries).toEqual([older, input]);
  expect(tryClaimSessionControllerTask(input)).toBeUndefined();
  retireSessionControllerInput(older);
  await older.settlement.promise;
  const claim = tryClaimSessionControllerTask(input)!;
  expect(claim.inputs).toEqual([input]);
  releaseSessionControllerClaim(claim);
});

it("does not invent a mailbox for a sessionless source", async () => {
  const prepared = await prepareReplySourceInput({}, {}, undefined);
  expect(prepared.input).toBeUndefined();
});

it.each(["running", "queued"] as const)(
  "cancels only the captured %s source and waits for its producer to settle",
  async (kind) => {
    let cancel: ((assertCurrent: () => void) => Promise<boolean>) | undefined;
    const active = await prepare(
      key,
      kind === "running"
        ? {
            onReplySourceCancellation: (handle) => {
              cancel = handle;
            },
          }
        : undefined,
    );
    const started = createDeferred();
    const finish = createDeferred();
    let activeSignal: AbortSignal | undefined;
    const execution = withSessionTurn(
      {
        sessionKey: key,
        sessionId: "source-session",
        storePath: target.storeScope,
        controllerInput: active.input,
      },
      async (_operation, signal) => {
        activeSignal = signal;
        started.resolve();
        await finish.promise;
        signal.throwIfAborted();
      },
    );
    void execution.catch(() => {});
    await started.promise;
    try {
      const selected =
        kind === "running"
          ? active
          : await prepare(key, {
              onReplySourceCancellation: (handle) => {
                cancel = handle;
              },
            });
      const neighbor = await prepare();
      expect(cancel).toBeTypeOf("function");
      const settled = vi.fn();
      const outcome = cancel!(() => {}).then((result) => {
        settled(result);
        return result;
      });
      expect(selected.input?.abortSignal.aborted).toBe(true);
      expect(neighbor.input?.abortSignal.aborted).toBe(false);
      expect(activeSignal?.aborted).toBe(kind === "running");
      if (kind === "running") {
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
      } else {
        await expect(outcome).resolves.toBe(true);
      }
      finish.resolve();
      await Promise.allSettled([execution]);
      await expect(outcome).resolves.toBe(true);
      await expect(cancel!(() => {})).resolves.toBe(false);
      const next = tryClaimSessionControllerTask(neighbor.input!);
      expect(next?.inputs).toEqual([neighbor.input]);
      releaseSessionControllerClaim(next!);
    } finally {
      finish.resolve();
      await Promise.allSettled([execution]);
    }
  },
);

it.each(["injected", "collected"] as const)(
  "refuses to cancel a source whose %s execution is not independently owned",
  async (kind) => {
    let cancel: ((assertCurrent: () => void) => Promise<boolean>) | undefined;
    const selected = await prepare(key, {
      onReplySourceCancellation: (handle) => {
        cancel = handle;
      },
    });
    const input = selected.input!;
    if (kind === "injected") {
      const injection = beginSessionControllerSourceInjection(input);
      expect(await injection.admit()).toBe(true);
      await expect(cancel!(() => {})).resolves.toBe(false);
      expect(input.abortSignal.aborted).toBe(false);
      injection.finish(false);
      retireSessionControllerInput(input);
    } else {
      const claim = tryClaimSessionControllerTask(input)!;
      const operation = createReplyOperation({
        mailboxClaim: claim,
        target,
        sessionKey: key,
        sessionId: "source-session",
        resetTriggered: false,
      });
      const neighbor = await prepare();
      const run = createQueueTestRun({ prompt: "neighbor" });
      bindReplySourceToFollowup(neighbor.options, run);
      attachSessionControllerInputOperation(run, operation);
      await expect(cancel!(() => {})).resolves.toBe(false);
      expect(operation.abortSignal.aborted).toBe(false);
      expect(neighbor.input?.abortSignal.aborted).toBe(false);
      operation.complete();
      releaseSessionControllerClaim(claim);
      await operation.ownerSettlement;
    }
  },
);

it.each(["source cancellation", "producer failure"] as const)(
  "retains late-adopted native work and classifies its %s settlement",
  async (kind) => {
    let cancel: ((assertCurrent: () => void) => Promise<boolean>) | undefined;
    const prepared = await prepare(key, {
      onReplySourceCancellation: (handle) => {
        cancel = handle;
      },
    });
    const coordinator = createDispatchReplyOperationCoordinator({
      agentId: "main",
      cfg: {},
      ctx: finalizeInboundContext({ Body: "synthetic native turn", SessionKey: key }),
      dispatcher: createReplyDispatcher({ deliver: async () => {} }),
      dispatchOperationSessionKey: key,
      operationSessionStoreEntry: { storePath: target.storeScope },
      replyOptions: prepared.options,
      resolveOperationExpectedSessionId: () => undefined,
    });
    const started = createDeferred();
    const finish = createDeferred();
    const failure = new Error("independent producer failure");
    const work = coordinator.runWithDispatchLifecycleAdmission(() =>
      withSessionTurn(
        {
          sessionKey: key,
          sessionId: "native-session",
          storePath: target.storeScope,
          controllerInput: prepared.input,
        },
        async (_operation, signal) => {
          started.resolve();
          await finish.promise;
          if (kind === "producer failure") {
            throw failure;
          }
          signal.throwIfAborted();
        },
      ),
    );
    void work.catch(() => {});
    let canceled: Promise<boolean> | undefined;
    try {
      await started.promise;
      canceled = cancel!(() => {});
      void canceled.catch(() => {});
      const published = vi.fn();
      void canceled.then(published, published);
      await Promise.resolve();
      expect(published).not.toHaveBeenCalled();
      finish.resolve();
      if (kind === "source cancellation") {
        await expect(canceled).resolves.toBe(true);
      } else {
        await expect(canceled).rejects.toMatchObject({ errors: [failure] });
      }
    } finally {
      finish.resolve();
      await Promise.allSettled([work, canceled]);
    }
  },
);

it("rechecks the requesting authority at the exact source abort", async () => {
  let cancel: ((assertCurrent: () => void) => Promise<boolean>) | undefined;
  const prepared = await prepare(key, {
    onReplySourceCancellation: (handle) => {
      cancel = handle;
    },
  });
  const started = createDeferred();
  const finish = createDeferred();
  const effect = createDeferred();
  const revoked = new Error("request authority revoked");
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw revoked;
    }
  };
  const work = withSessionTurn(
    {
      sessionKey: key,
      sessionId: "authority-session",
      storePath: target.storeScope,
      controllerInput: prepared.input,
    },
    async (_operation, signal) => {
      started.resolve();
      await finish.promise;
      signal.throwIfAborted();
    },
  );
  void work.catch(() => {});
  let pending: Promise<boolean> | undefined;
  try {
    await started.promise;
    assertCurrent();
    pending = effect.promise.then(() => cancel!(assertCurrent));
    void pending.catch(() => {});
    current = false;
    effect.resolve();
    await Promise.resolve();
    expect(prepared.input?.abortSignal.aborted).toBe(false);
    await expect(pending).rejects.toBe(revoked);
    finish.resolve();
    await expect(work).resolves.toBeUndefined();
  } finally {
    effect.resolve();
    finish.resolve();
    await Promise.allSettled([work, pending]);
  }
});

it("preserves lifecycle cancellation without reserving input", async () => {
  const caller = new AbortController();
  const lifecycle = new AbortController();
  const reason = new Error("source cancelled");
  lifecycle.abort(reason);
  const prepared = await prepare(key, {
    abortSignal: caller.signal,
    turnAdoptionLifecycle: { abortSignal: lifecycle.signal, onAdopted() {} },
  });
  expect(caller.signal.aborted).toBe(false);
  expect(prepared.options.abortSignal?.aborted).toBe(true);
  expect(prepared.options.abortSignal?.reason).toBe(reason);
  expect(prepared.input).toBeUndefined();
  expect(getExistingSessionControllerMailbox(key, target)).toBeUndefined();
});

it("keeps newest interrupt priority after older policy refinement and through delivery", async () => {
  const older = reserve();
  updateSessionControllerSourcePolicy(older, { mode: "interrupt", cap: 2 });
  const newest = reserve();
  updateSessionControllerSourcePolicy(newest, { mode: "interrupt", cap: 3 });
  updateSessionControllerSourcePolicy(older, { mode: "interrupt", cap: 4 });
  expect(older.policy).toEqual({ mode: "interrupt", cap: 4 });
  expect(older.mailbox.priority).toBe(newest);
  expect(older.mailbox.entries).toEqual([older, newest]);
  updateSessionControllerSourcePolicy(older, { mode: "followup" });
  expect(tryClaimSessionControllerTask(older)).toBeUndefined();
  expect(older.phase).toBe("preparing");
  const claim = tryClaimSessionControllerTask(newest)!;
  expect(claim.inputs).toEqual([newest]);
  const operation = createReplyOperation({
    mailboxClaim: claim,
    target,
    sessionKey: key,
    sessionId: "source-session",
    resetTriggered: false,
  });
  const run = createQueueTestRun({ prompt: "hello" });
  bindReplySourceToFollowup(bindReplySourceInput({}, newest), run);
  expect(newest.mailbox.entries).toEqual([older, newest]);
  const raw = createDeferred();
  operation.completeWithAfterClearBarrier(raw.promise);
  releaseSessionControllerClaim(claim);
  const selected = vi.fn();
  const next = claimSessionControllerTask(older, selected, "queued_followup");
  await Promise.resolve();
  expect(selected).not.toHaveBeenCalled();
  raw.resolve();
  await operation.ownerSettlement;
  const nextClaim = await next;
  expect(selected).toHaveBeenCalledOnce();
  releaseSessionControllerClaim(nextClaim);
});
