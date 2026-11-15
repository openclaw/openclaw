import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, assert, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { log as runnerLog } from "../agents/embedded-agent-runner/logger.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../agents/embedded-agent-runner/run-state.js";
import { isEmbeddedAgentRunHandleActive as isActive } from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle as makeHandle,
  registerTestEmbeddedRun as admitRun,
  testing as embeddedRunsTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { MessageInjectionAcceptedUnconfirmedError } from "../auto-reply/reply/message-injection-authority.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import * as diagnosticActivity from "../logging/diagnostic-run-activity.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  abortAgentHarnessRun as abortRun,
  abortAndDrainAgentHarnessRun as drainRun,
  AgentHarnessPreflightError,
  agentHarnessStructuredInput,
  buildAgentHarnessUserInputAnswers as buildAnswers,
  classifyAgentHarnessTerminalOutcome as classifyOutcome,
  clearActiveEmbeddedRun as clear,
  deliverAgentHarnessUserInputPrompt as deliverPrompt,
  formatAgentHarnessUserInputPrompt as formatPrompt,
  queueAgentHarnessMessage as queue,
  setActiveEmbeddedRun as register,
  type AgentHarness,
  type AgentHarnessQuestionGatewayCall,
  type AgentHarnessAttemptParams as Attempt,
  type AgentHarnessAttemptParamsV2 as AttemptV2,
  type AgentHarnessSideQuestionParams as SideQuestion,
  type AgentHarnessSideQuestionParamsV2 as SideQuestionV2,
  type AgentHarnessSessionForkParams,
  type AgentHarnessV2,
  type EmbeddedRunAttemptParams as EmbeddedAttempt,
  type EmbeddedRunAttemptParamsV2 as EmbeddedAttemptV2,
  type HarnessContextEngine,
} from "./agent-harness-runtime.js";

type Handle = Parameters<typeof register>[1];
type Cleanup = ReturnType<typeof register>;
type QueueOptions = Parameters<typeof queue>[2];
type ForkV2 = Parameters<NonNullable<AgentHarnessV2["sessionForkV2"]>["fork"]>[0];
type WithoutHost<T> = Omit<T, "hostCapabilities">;
type RequiresHost<T> = WithoutHost<T> extends T ? false : true;
const cleanupWith = (...actions: Array<() => void>) => ({
  [Symbol.dispose]() {
    for (const action of actions) {
      action();
    }
  },
});
const nativeHandle = (overrides: Partial<Handle> = {}): Handle => ({
  queueMessage: async () => {},
  isStreaming: () => true,
  isCompacting: () => false,
  abort: () => {},
  ...overrides,
});
function nativeSink(
  kind: "legacy" | "V1" | "V2",
  queueMessage: Handle["queueMessage"],
  available = true,
  overrides: Partial<Handle> = {},
): Handle {
  const injection = { isAvailable: () => available, queueMessage };
  const handle = nativeHandle({ ...overrides, queueMessage });
  if (kind === "V1") {
    handle.messageInjection = injection;
  } else if (kind === "V2") {
    handle.messageInjectionV2 = {
      ...injection,
      version: 2,
      queueMessage: (text, options, assertCurrent) => {
        assertCurrent();
        return queueMessage(text, options);
      },
    };
  }
  return handle;
}
const aliasEffect = (sessionId: string, scope = "/tmp/sdk-detached-store") =>
  beginSessionEffect({ scope, identities: [sessionId] });
const replyOperation = (sessionId: string, sessionKey: string) =>
  createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
const admittedRun = (id: string, options: Parameters<typeof makeHandle>[0] = {}) =>
  admitRun(id, makeHandle(options), `agent:main:${id}`);
type Question = Parameters<typeof formatPrompt>[0][number];
const question = (id: string, options: Partial<Question> = {}): Question => ({
  id,
  header: id,
  question: id,
  ...options,
});
const drained = { aborted: true, drained: true, forceCleared: false };
const revoked = "Message injection authority is no longer current";
const captureInjection = () => {
  let retained: (() => void) | undefined;
  const handle = nativeHandle({
    messageInjectionV2: {
      version: 2,
      isAvailable: () => true,
      queueMessage: async (_text, _options, assertCurrent) => {
        retained = assertCurrent;
      },
    },
  });
  return { handle, authority: () => expectDefined(retained, "detached injection authority") };
};
const cancellationModes = ["single", "all", "compacting", "drain"] as const;
type CancelMode = (typeof cancellationModes)[number];
const cancel = (sessionId: string, mode: CancelMode) =>
  mode === "drain"
    ? drainRun({ sessionId })
    : mode === "single"
      ? abortRun(sessionId)
      : abortRun(undefined, { mode });
async function expectCancellation(
  result: ReturnType<typeof cancel>,
  mode: CancelMode,
  aborted: boolean,
) {
  if (mode === "drain") {
    await expect(result).resolves.toEqual({ ...drained, aborted });
  } else {
    expect(result).toBe(aborted);
  }
}
async function cancellingRun(
  id: string,
  scope?: string,
  overrides: Partial<Handle> = {},
  timers = false,
) {
  if (timers) {
    vi.useFakeTimers();
  }
  const effect = scope ? await aliasEffect(id, scope) : undefined;
  const abort = vi.fn();
  const cleanup = register(id, { ...makeHandle({ abort, isCompacting: true }), ...overrides });
  const successors: Cleanup[] = [];
  return {
    abort,
    cleanup,
    replace(nextAbort = vi.fn()) {
      successors.push(register(id, makeHandle({ abort: nextAbort })));
      return nextAbort;
    },
    [Symbol.dispose]() {
      cleanup?.();
      for (const successor of successors) {
        successor?.();
      }
      effect?.release();
      if (timers) {
        vi.useRealTimers();
      }
    },
  };
}

it.each([
  [{ assistantTexts: ["NO_REPLY"] }, undefined],
  [{ assistantTexts: ["  ", "\n\t"] }, "empty"],
  [{ reasoningText: "reasoning", planText: "plan" }, "planning-only"],
  [{ reasoningText: "reasoning" }, "reasoning-only"],
] satisfies Array<
  [Partial<Parameters<typeof classifyOutcome>[0]>, ReturnType<typeof classifyOutcome>]
>)("classifies %j as %s", (input, expected) => {
  expect(
    classifyOutcome({
      assistantTexts: [],
      reasoningText: "",
      planText: "",
      promptError: null,
      turnCompleted: true,
      ...input,
    }),
  ).toBe(expected);
});

describe("agent harness runtime SDK facade", () => {
  it("preserves the published failure-retention opt-in on attempt operations", () => {
    expectTypeOf<
      NonNullable<Attempt["replyOperation"]>["retainFailureUntilComplete"]
    >().toEqualTypeOf<() => void>();
    expectTypeOf<
      NonNullable<EmbeddedAttemptV2["replyOperation"]>["retainFailureUntilComplete"]
    >().toEqualTypeOf<() => void>();
  });

  it("exposes optional compaction progress without requiring it from legacy engines", () => {
    type CompactParams = Parameters<HarnessContextEngine["compact"]>[0];
    expectTypeOf<CompactParams["onProgress"]>().toEqualTypeOf<(() => void) | undefined>();
    expectTypeOf<Omit<CompactParams, "onProgress">>().toMatchTypeOf<CompactParams>();
  });

  it("keeps legacy harness implementations source-compatible while requiring capabilities in V2", () => {
    expectTypeOf({
      id: "legacy-test",
      label: "Legacy test harness",
      supports: () => ({ supported: true as const, priority: 1 }),
      runAttempt: async (_params: Attempt) => {
        throw new Error("type-only legacy harness");
      },
      runSideQuestion: async (_params: SideQuestion) => ({ text: "legacy" }),
    } satisfies AgentHarness).toMatchTypeOf<AgentHarness>();
    expectTypeOf<AgentHarnessV2>().toMatchTypeOf<AgentHarness>();
    expectTypeOf<Omit<AttemptV2, "onSettledTurn">>().toMatchTypeOf<AttemptV2>();
    expectTypeOf<WithoutHost<Attempt>>().toMatchTypeOf<
      Parameters<NonNullable<AgentHarness["finalizeSettledTurn"]>>[0]["attempt"]
    >();
    expectTypeOf<WithoutHost<AttemptV2>>().toMatchTypeOf<
      Parameters<NonNullable<AgentHarnessV2["finalizeSettledTurn"]>>[0]["attempt"]
    >();
    expectTypeOf<Parameters<NonNullable<AttemptV2["onSettledTurn"]>>[0]>().not.toHaveProperty(
      "contextEngineTerminalAnchor",
    );
    expectTypeOf<WithoutHost<SideQuestion>>().toMatchTypeOf<SideQuestion>();
    expectTypeOf<WithoutHost<Attempt>>().toMatchTypeOf<Attempt>();
    expectTypeOf<WithoutHost<EmbeddedAttempt>>().toMatchTypeOf<EmbeddedAttempt>();
    expectTypeOf<Attempt["replyOperation"]>().toEqualTypeOf<EmbeddedAttempt["replyOperation"]>();
    expectTypeOf<RequiresHost<AttemptV2>>().toEqualTypeOf<true>();
    expectTypeOf<RequiresHost<EmbeddedAttemptV2>>().toEqualTypeOf<true>();
    expectTypeOf<RequiresHost<SideQuestionV2>>().toEqualTypeOf<true>();
    expectTypeOf<Omit<ForkV2, "assertCurrent">>().toEqualTypeOf<AgentHarnessSessionForkParams>();
    expectTypeOf<
      Omit<ForkV2, "assertCurrent"> extends ForkV2 ? true : false
    >().toEqualTypeOf<false>();

    // V1 injection remains supported inside a host-admitted harness attempt.
    const queueMessage = async (_text: string, _options?: QueueOptions) => {};
    expectTypeOf({
      queueMessage,
      messageInjection: { isAvailable: () => true, queueMessage },
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    } satisfies Handle).toMatchTypeOf<Handle>();
    expectTypeOf<Extract<keyof Handle, symbol>>().toEqualTypeOf<never>();
    expectTypeOf<Parameters<typeof register>["length"]>().toEqualTypeOf<2 | 3 | 4 | 5>();
    expectTypeOf<ReturnType<typeof register>>().toEqualTypeOf<
      ((reason?: string) => void) | undefined
    >();
    expectTypeOf(queue).returns.toEqualTypeOf<boolean>();
    type GuardedInjection = NonNullable<Handle["messageInjectionV2"]>;
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>[2]>().toEqualTypeOf<() => void>();
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>[3]>().toEqualTypeOf<
      "run" | "source-bound"
    >();
    expectTypeOf<Parameters<GuardedInjection["queueMessage"]>["length"]>().toEqualTypeOf<4>();
  });

  it("keeps legacy question callbacks and requires explicit guarded dispatch authority", () => {
    type Legacy = (
      method: string,
      opts: { timeoutMs?: number },
      params?: unknown,
      extra?: { signal?: AbortSignal },
    ) => Promise<unknown>;
    expectTypeOf<AgentHarnessQuestionGatewayCall>().toEqualTypeOf<Legacy>();
    type Override = Parameters<typeof agentHarnessStructuredInput.run>[0]["gatewayCall"];
    expectTypeOf<Legacy>().toMatchTypeOf<Override>();
    expectTypeOf<undefined>().toMatchTypeOf<Override>();
    type Dispatcher = Exclude<Override, Legacy | undefined>;
    type Request = Parameters<Dispatcher["call"]>[0];
    type Protected = Extract<Request["authority"], { kind: "source-bound" }>;
    expectTypeOf<Dispatcher["version"]>().toEqualTypeOf<2>();
    expectTypeOf<Protected["assertCurrent"]>().toEqualTypeOf<() => void>();
    expectTypeOf<Omit<Protected, "assertCurrent">>().not.toMatchTypeOf<Protected>();
  });

  it("exposes structured input through one frozen named runtime surface", () => {
    const keys = ["compileForm", "compileQuestions", "compileUrl", "isRecord", "run", "snapshot"];
    expect(Object.isFrozen(agentHarnessStructuredInput)).toBe(true);
    expect(Object.keys(agentHarnessStructuredInput).toSorted()).toEqual(keys);
  });
});

describe("agent harness active-run SDK controls", () => {
  afterEach(() => embeddedRunsTesting.resetActiveEmbeddedRuns());

  it("retires ownerless diagnostics without letting prior cleanup erase a successor", () => {
    const ref = { sessionId: "sdk-diagnostic-cleanup" };
    const attach = (runId: string) => register(ref.sessionId, makeHandle({ runId }));
    const priorCleanup = attach("prior-diagnostic-run");
    const successorCleanup = attach("successor-diagnostic-run");
    const snapshot = () => diagnosticActivity.getDiagnosticSessionActivitySnapshot(ref);
    const active = { activeWorkKind: "embedded_run", hasActiveEmbeddedRun: true };
    using _ = cleanupWith(
      () => priorCleanup?.(),
      () => successorCleanup?.(),
      () => diagnosticActivity.resetDiagnosticRunActivityForTest(),
    );
    expect(priorCleanup).toBeTypeOf("function");
    expect(successorCleanup).toBeTypeOf("function");
    expect(snapshot()).toMatchObject(active);

    priorCleanup?.();
    expect(snapshot()).toMatchObject(active);

    successorCleanup?.();
    const settled = snapshot();
    expect([settled.activeWorkKind, settled.hasActiveEmbeddedRun]).toEqual([undefined, undefined]);
  });

  it("rejects a session-keyed registration without host admission", () => {
    const handle = makeHandle();
    let failure: unknown;
    try {
      register("unadmitted", handle, "agent:main:unadmitted");
    } catch (error) {
      failure = error;
    }
    assert.instanceOf(failure, AgentHarnessPreflightError);
    expect(failure.code).toBe("SESSION_CONTROLLER_ADMISSION_REQUIRED");
    expect(failure.scope).toBeUndefined();
    expect(failure.message).toContain("runAttempt");
    expect(failure.userMessage).toBe(failure.message);
  });

  it("steers and interrupts the admitted turn while keeping waiting input", async () => {
    const queueMessage = vi.fn(async () => {});
    const operation = admittedRun("sdk-turn", { queueMessage });
    expect(queue("sdk-turn", "steer")).toBe(true);
    await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
    const waiting = reserveSessionControllerSource("agent:main:sdk-turn", {
      policy: { mode: "followup" },
    });
    using _ = cleanupWith(() => retireSessionControllerInput(waiting));
    expect(abortRun("sdk-turn")).toBe(true);
    expect(operation.result).toMatchObject({ kind: "aborted", code: "aborted_by_user" });
    expect(waiting.retirementRequested).toBeUndefined();
  });

  it("warns when an admitted asynchronous steer has an unconfirmed outcome", async () => {
    const finish = createDeferredCore();
    const warn = vi.spyOn(runnerLog, "warn").mockImplementation(() => {});
    const queueMessage = vi.fn(async () => {
      await finish.promise;
      throw new MessageInjectionAcceptedUnconfirmedError({
        cause: new Error("synthetic receipt loss"),
      });
    });
    const operation = admittedRun("sdk-unconfirmed", { queueMessage, guarded: true });
    using _ = cleanupWith(
      () => finish.resolve(),
      () => operation.complete(),
      () => warn.mockRestore(),
    );
    expect(queue("sdk-unconfirmed", "synthetic private input")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    finish.resolve();
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "queue message outcome unconfirmed: sessionId=sdk-unconfirmed; inspect the conversation before retrying",
      ),
    );
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(operation.abortSignal.aborted).toBe(false);
  });

  it.each(["legacy", "V1", "V2"] as const)("queues detached %s input", async (kind) => {
    const queueMessage = vi.fn(async (_text: string, _options?: QueueOptions) => {});
    const abort = vi.fn();
    const handle = nativeSink(kind, queueMessage, true, { abort });
    const effect = await aliasEffect("sdk-detached");
    // The alias must be released before checking detached abort, not at test teardown.
    try {
      register("sdk-detached", handle);
      expect(queue("sdk-detached", "steer")).toBe(true);
      await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
      expect(queueMessage.mock.calls[0]?.[0]).toBe("steer");
    } finally {
      effect.release();
    }
    expect(abortRun("sdk-detached")).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
  });

  it.each(cancellationModes)("cancels detached %s work", async (mode) => {
    const sessionId = "sdk-detached-cancel";
    using run = await cancellingRun(sessionId, "/tmp/sdk-detached-cancel-store", {}, true);
    const { abort, cleanup } = run;
    expect(isActive(sessionId)).toBe(false);
    if (mode === "drain") {
      let returned = false;
      const draining = drainRun({ sessionId, settleMs: 100 }).then((result) => {
        returned = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(abort).toHaveBeenCalledOnce();
      expect(returned).toBe(false);
      const successorAbort = run.replace();
      cleanup?.();
      await expect(draining).resolves.toEqual(drained);
      expect(successorAbort).not.toHaveBeenCalled();
    } else {
      expect(cancel(sessionId, mode)).toBe(true);
      expect(abort).toHaveBeenCalledOnce();
    }
  });

  it.each(cancellationModes)("rejects %s probe replacement", async (mode) => {
    const sessionId = "sdk-detached-cancel-replaced";
    const successorAbort = vi.fn();
    const isAbortable = vi.fn(() => {
      run.replace(successorAbort);
      run.cleanup?.();
      return true;
    });
    using run = await cancellingRun(sessionId, "/tmp/sdk-detached-cancel-replaced-store", {
      isAbortable,
    });
    await expectCancellation(cancel(sessionId, mode), mode, false);
    expect(isAbortable).toHaveBeenCalledOnce();
    expect(run.abort).not.toHaveBeenCalled();
    expect(successorAbort).not.toHaveBeenCalled();
  });

  it.each(cancellationModes)("prioritizes the %s controller", async (mode) => {
    const sessionId = "sdk-detached-cancel-controller";
    using run = await cancellingRun(sessionId);
    const operation = replyOperation(sessionId, "agent:main:sdk-cancel-controller");
    using _ = cleanupWith(() => operation.complete());
    const result = cancel(sessionId, mode);
    expect(run.abort).not.toHaveBeenCalled();
    expect(operation.abortSignal.aborted).toBe(mode !== "compacting");
    operation.complete();
    await expectCancellation(result, mode, mode !== "compacting");
  });

  it.each(["single", "drain"] as const)("rejects ambiguous %s owners", async (mode) => {
    const sessionId = "sdk-detached-cancel-ambiguous";
    using run = await cancellingRun(sessionId, undefined, { isCompacting: () => false });
    const first = replyOperation(sessionId, "agent:main:sdk-cancel-first");
    const second = replyOperation(sessionId, "agent:main:sdk-cancel-second");
    using _ = cleanupWith(
      () => first.complete(),
      () => second.complete(),
    );
    if (mode === "drain") {
      await expect(drainRun({ sessionId })).rejects.toThrow();
    } else {
      expect(() => abortRun(sessionId)).toThrow();
    }
    expect(run.abort).not.toHaveBeenCalled();
    expect(first.abortSignal.aborted).toBe(false);
    expect(second.abortSignal.aborted).toBe(false);
  });

  it.each(["not streaming", "stopped", "V1 unavailable", "V2 unavailable", "stale"] as const)(
    "refuses a sessionless native sink that is %s",
    async (state) => {
      const queueMessage = vi.fn(async () => {});
      const kind = state === "V1 unavailable" ? "V1" : state === "V2 unavailable" ? "V2" : "legacy";
      const handle = nativeSink(kind, queueMessage, false, {
        isStreaming: () => state !== "not streaming",
        ...(state === "stopped" ? { isStopped: () => true } : {}),
      });
      const effect = await aliasEffect("sdk-unavailable", "/tmp/sdk-unavailable-store");
      const activity =
        state === "stale"
          ? vi.spyOn(diagnosticActivity, "getDiagnosticSessionActivitySnapshot").mockReturnValue({
              lastProgressAgeMs: 11 * 60_000,
            })
          : undefined;
      using _ = cleanupWith(
        () => activity?.mockRestore(),
        () => effect.release(),
      );
      register("sdk-unavailable", handle);
      expect(queue("sdk-unavailable", "steer")).toBe(false);
      expect(queueMessage).not.toHaveBeenCalled();
    },
  );

  it.each(["V1", "V2"] as const)("checks detached %s authority", (kind) => {
    const queueMessage = vi.fn(async () => {});
    const handle = nativeSink(kind, queueMessage);
    register("sdk-revoked-caller", handle);
    const options = {
      steeringMode: "all" as const,
      assertCurrent: () => {
        throw new Error("caller authority revoked");
      },
    };
    expect(() => queue("sdk-revoked-caller", "steer", options)).toThrow(
      kind === "V1" ? "caller authority revoked" : revoked,
    );
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("does not substitute a raw fingerprint for sessionless overlay projection authority", () => {
    const queueMessage = vi.fn(async () => {});
    register(
      "sdk-overlay",
      nativeHandle({
        queueMessage,
        toolAuthorityFingerprint: "current-authority",
      }),
    );
    const options = {
      isInboundUserMessage: true,
      toolAuthorityFingerprint: "current-authority",
      toolAuthorityOverlay: { senderIsOwner: false, disableTools: false, traceAuthorized: false },
    };
    expect(queue("sdk-overlay", "steer", options)).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("revokes sessionless V2 injection when its exact native registration is replaced", () => {
    const { handle, authority } = captureInjection();
    const firstCleanup = expectDefined(
      register("sdk-replaced", handle),
      "first native registration",
    );
    expect(queue("sdk-replaced", "first")).toBe(true);
    const firstAssertion = authority();
    expect(firstAssertion).not.toThrow();

    const secondCleanup = expectDefined(
      register("sdk-replaced", handle),
      "second native registration",
    );
    clear("sdk-replaced", handle, undefined, undefined, "old_cleanup", firstCleanup);
    expect(firstAssertion).toThrow(revoked);
    expect(isActive("sdk-replaced")).toBe(true);
    expect(queue("sdk-replaced", "second")).toBe(true);
    const secondAssertion = authority();
    expect(secondAssertion).not.toThrow();
    secondCleanup();
    expect(secondAssertion).toThrow(revoked);
    expect(isActive("sdk-replaced")).toBe(false);
  });

  it.each(["human", "runtime"] as const)("preserves a detached %s wait", async (kind) => {
    const sessionId = `sdk-protected-${kind}`;
    const instance = createOperationalRunInstanceRef(`${sessionId}-run`);
    const authority = claimAgentRunDelegatedAuthority(instance);
    const effect = await aliasEffect(sessionId, "/tmp/sdk-protected-store");
    const activity = vi
      .spyOn(diagnosticActivity, "getDiagnosticSessionActivitySnapshot")
      .mockReturnValue({ lastProgressAgeMs: 11 * 60_000 });
    const queueMessage = vi.fn(async () => {});
    let runtimeWaiting = kind === "runtime";
    let cleanup: Cleanup = undefined;
    let releaseWait: ((resolved: boolean) => void) | undefined;
    const caller = {
      agentId: "main",
      sessionKey: `agent:main:${sessionId}`,
      operationalRunInstance: instance,
    };
    const handle = nativeHandle({
      runId: instance.runId,
      queueMessage,
      ownsLiveness: () => runtimeWaiting,
    });
    using _ = cleanupWith(
      () => releaseWait?.(false),
      () => cleanup?.(),
      () => releaseAgentRunDelegatedAuthority(authority),
      () => effect.release(),
      () => activity.mockRestore(),
    );
    cleanup = await withGatewayToolCallerIdentity(caller, () => register(sessionId, handle));
    if (kind === "human") {
      releaseWait = expectDefined(
        registerActiveEmbeddedRunHumanInputWait(authority, () => true),
        "exact detached human-input wait",
      );
    }
    expect(queue(sessionId, "answer")).toBe(true);
    await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
    releaseWait?.(false);
    runtimeWaiting = false;
    expect(queue(sessionId, "stale followup")).toBe(false);
    expect(queueMessage).toHaveBeenCalledOnce();
  });

  it("revokes retained detached injection when a controller takes the same ID", () => {
    const { handle, authority } = captureInjection();
    register("sdk-controller-takeover", handle);
    expect(queue("sdk-controller-takeover", "first")).toBe(true);
    const assertion = authority();
    expect(assertion).not.toThrow();
    const operation = admittedRun("sdk-controller-takeover");
    using _ = cleanupWith(() => operation.complete());
    expect(assertion).toThrow(revoked);
  });
});

describe("agent harness user input helpers", () => {
  it("formats prompts and delivers through blocking replies first", async () => {
    const onBlockReply = vi.fn();
    const questions = [
      question("mode", {
        header: "Mode",
        question: "Pick a <mode>",
        isOther: true,
        options: [{ label: "Deep", description: "Use more context" }],
      }),
    ];
    await deliverPrompt({ onBlockReply }, questions, {
      intro: "Runtime needs input:",
      formatText: (text) => text.replaceAll("<", "&lt;"),
    });
    expect(onBlockReply).toHaveBeenCalledWith({
      text: `Runtime needs input:

Mode
Pick a &lt;mode>
1. Deep - Use more context
Other: reply with your own answer.`,
    });
  });

  it("keeps a comma-containing option label as one multi-select answer", () => {
    const questions = [
      question("region", {
        multiSelect: true,
        isOther: true,
        options: [{ label: "Frankfurt, Germany" }, { label: "Dublin, Ireland" }],
      }),
    ];
    expect(buildAnswers(questions, "Frankfurt, Germany")).toEqual({
      answers: { region: { answers: ["Frankfurt, Germany"] } },
    });
  });

  it("preserves blank fallback lines so skipped answers stay aligned", () => {
    expect(buildAnswers([question("q1"), question("q2"), question("q3")], "\nyes\nno")).toEqual({
      answers: {
        q1: { answers: [] },
        q2: { answers: ["yes"] },
        q3: { answers: ["no"] },
      },
    });
  });
});
