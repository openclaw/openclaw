import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  claimSessionControllerTask,
  releaseSessionControllerClaim,
  reserveSessionControllerSource,
  retireSessionControllerInput,
  tryClaimSessionControllerTask,
  updateSessionControllerSourcePolicy,
  getExistingSessionControllerMailbox,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { withAgentInputRecoveryContext } from "../../state/agent-input-recovery-context.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import { runPreparedReply } from "./get-reply-run.js";
import { baseParams } from "./get-reply-run.test-support.js";
import { prepareInternalGetReplyOptions } from "./get-reply.types.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
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
function prepare(sessionKey = key, store = "/test/source.sqlite", commandTarget?: string) {
  return prepareReplySourceInput(
    { SessionKey: sessionKey, CommandTargetSessionKey: commandTarget },
    { session: { store } },
    undefined,
  );
}

it("carries the Gateway source through lifecycle/options spreads to the actual followup", async () => {
  const input = reserve();
  const lifecycle: TurnAdoptionLifecycle = bindReplySourceInput({ onAdopted() {} }, input);
  const options = prepareInternalGetReplyOptions({
    turnAdoptionLifecycle: { ...lifecycle, onAdopted: async () => lifecycle.onAdopted() },
  });
  const prepared = await prepareReplySourceInput(
    { SessionKey: key },
    { session: { store: "/test/source.sqlite" } },
    { ...options },
  );
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
  const source = await prepare(key, "/test/actual.sqlite", "agent:main:other");
  expect(source.input?.mailbox.owner.target).toMatchObject({
    sessionKey: key,
    storeScope: "/test/actual.sqlite",
  });
  const otherStore = await prepare(key, "/test/other.sqlite");
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
    ctx: { SessionKey: slash, CommandSource: "native", CommandTargetSessionKey: key },
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

it("preserves lifecycle cancellation before pending recovery without reserving input", async () => {
  const recovery = createDeferred();
  const caller = new AbortController();
  const lifecycle = new AbortController();
  const reason = new Error("source cancelled");
  lifecycle.abort(reason);
  try {
    const prepared = await withAgentInputRecoveryContext(
      () => ({
        isPending: () => true,
        waitForAgentInputRecovery: (_agentId, options) =>
          racePromiseWithAbortSignal(recovery.promise, options?.signal),
      }),
      () =>
        prepareReplySourceInput(
          { SessionKey: key },
          { session: { store: target.storeScope } },
          {
            abortSignal: caller.signal,
            turnAdoptionLifecycle: { abortSignal: lifecycle.signal, onAdopted() {} },
          },
        ),
    );
    expect(caller.signal.aborted).toBe(false);
    expect(prepared.options.abortSignal?.aborted).toBe(true);
    expect(prepared.options.abortSignal?.reason).toBe(reason);
    expect(prepared.input).toBeUndefined();
    expect(getExistingSessionControllerMailbox(key, target)).toBeUndefined();
  } finally {
    recovery.resolve();
  }
});

it("waits for only its agent's recovery before reserving fresh input", async () => {
  const recovery = createDeferred();
  const otherKey = "agent:other:source-binding";
  const waiting = withAgentInputRecoveryContext(
    () => ({
      isPending: (agentId) => agentId === "main",
      waitForAgentInputRecovery: (agentId) => (agentId === "main" ? recovery.promise : undefined),
    }),
    () => prepare(),
  );
  expect(getExistingSessionControllerMailbox(key, target)).toBeUndefined();
  const other = await withAgentInputRecoveryContext(
    () => ({
      isPending: (agentId) => agentId === "main",
      waitForAgentInputRecovery: (agentId) => (agentId === "main" ? recovery.promise : undefined),
    }),
    () => prepare(otherKey),
  );
  expect(other.input?.target?.agentId).toBe("other");
  recovery.resolve();
  const recovered = await waiting;
  expect(recovered.input?.target?.agentId).toBe("main");
  retireUnadoptedReplySource(other.input);
  retireUnadoptedReplySource(recovered.input);
});

it.each([
  { kind: "native", existing: false },
  { kind: "explicit", existing: false },
  { kind: "native", existing: true },
] as const)(
  "waits for the cross-agent $kind command target with existing source=$existing",
  async ({ kind, existing }) => {
    const recovery = createDeferred();
    const targetKey = "agent:other:command-target";
    const targetScope = captureSessionTarget({
      storeScope: target.storeScope,
      sessionKey: targetKey,
      agentId: "other",
    });
    const ctx = {
      SessionKey: key,
      CommandTargetSessionKey: targetKey,
      ...(kind === "native"
        ? { CommandSource: "native" as const }
        : {
            CommandSource: "text" as const,
            CommandAuthorized: true,
            BodyForCommands: "/tell other hello",
          }),
    };
    const reserved = existing ? await prepare() : undefined;
    const continued = vi.fn();
    const preparing = withAgentInputRecoveryContext(
      () => ({
        isPending: (agentId) => agentId === "other",
        waitForAgentInputRecovery: (agentId) =>
          agentId === "other" ? recovery.promise : undefined,
      }),
      async () => {
        const source = await prepareReplySourceInput(
          ctx,
          { session: { store: target.storeScope } },
          reserved?.options,
        );
        retargetReplySourceForExecution({
          ctx,
          options: source.options,
          sessionKey: targetKey,
          storePath: target.storeScope,
          agentId: "other",
        });
        continued();
        return source;
      },
    );
    try {
      await Promise.resolve();
      if (reserved) {
        expect(reserved.input?.target?.agentId).toBe("main");
      } else {
        expect(getExistingSessionControllerMailbox(key, target)).toBeUndefined();
      }
      expect(getExistingSessionControllerMailbox(targetKey, targetScope)).toBeUndefined();
      expect(continued).not.toHaveBeenCalled();
      recovery.resolve();
      const source = await preparing;
      expect(source.input?.target?.agentId).toBe("other");
      expect(source.input?.mailbox.owner.aliases.has(targetKey)).toBe(true);
      expect(continued).toHaveBeenCalledOnce();
    } finally {
      recovery.resolve();
      retireUnadoptedReplySource((await preparing).input);
    }
  },
);

it("preserves an exact live recovery source that already owns the command target", async () => {
  const targetKey = "agent:other:command-target";
  const source = await prepare(targetKey);
  const result = await withAgentInputRecoveryContext(
    () => ({
      isPending: (agentId) => agentId === "other",
      waitForAgentInputRecovery: () => {
        throw new Error("The target's recovery source must not wait on itself");
      },
    }),
    () =>
      prepareReplySourceInput(
        { SessionKey: key, CommandSource: "native", CommandTargetSessionKey: targetKey },
        { session: { store: target.storeScope } },
        source.options,
      ),
  );
  expect(result.input).toBe(source.input);
  retireUnadoptedReplySource(result.input);
});

it("prepares a late command target from the physical source context", async () => {
  const recovery = createDeferred();
  const controller = new AbortController();
  const reason = new Error("cancelled while waiting for command target recovery");
  const targetKey = "agent:other:late-command-target";
  const source = await prepareReplySourceInput(
    { SessionKey: key },
    { session: { store: target.storeScope } },
    { abortSignal: controller.signal },
  );
  const ctx = {
    SessionKey: key,
    CommandSource: "native" as const,
    CommandTargetSessionKey: targetKey,
  };
  const waited = vi.fn();
  const outcome = withAgentInputRecoveryContext(
    () => ({
      isPending: (agentId) => agentId === "other",
      waitForAgentInputRecovery: (agentId, options) => {
        if (agentId !== "other") {
          return undefined;
        }
        waited();
        return racePromiseWithAbortSignal(recovery.promise, options?.signal);
      },
    }),
    () =>
      runPreparedReply(
        baseParams({
          ctx,
          sessionCtx: { ...ctx, SessionKey: targetKey },
          cfg: { session: { store: target.storeScope } },
          opts: source.options,
          agentId: "other",
          sessionKey: targetKey,
          storePath: target.storeScope,
        }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      ),
  );
  try {
    await Promise.resolve();
    expect(waited).toHaveBeenCalledOnce();
    expect(source.input?.target?.agentId).toBe("main");
    controller.abort(reason);
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(source.input?.target?.agentId).toBe("main");
  } finally {
    controller.abort(reason);
    recovery.resolve();
    await outcome;
    retireUnadoptedReplySource(source.input);
  }
});

it.each(["live", "retired", "other session", "other store"] as const)(
  "reuses only an exact live source during recovery: %s",
  async (kind) => {
    const input = reserve();
    if (kind === "retired") {
      retireSessionControllerInput(input);
    }
    const preparing = withAgentInputRecoveryContext(
      () => ({
        isPending: () => true,
        waitForAgentInputRecovery: () => {
          throw new Error("Fresh input must await recovery");
        },
      }),
      () =>
        prepareReplySourceInput(
          { SessionKey: kind === "other session" ? `${key}:other` : key },
          { session: { store: kind === "other store" ? "/test/other.sqlite" : target.storeScope } },
          bindReplySourceInput({}, input),
        ),
    );
    if (kind === "live") {
      expect((await preparing).input).toBe(input);
    } else {
      await expect(preparing).rejects.toThrow("Reply source no longer owns the requested session");
    }
    retireUnadoptedReplySource(input);
  },
);

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
