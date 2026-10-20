/**
 * Tests agent harness runtime helpers and task dispatch behavior.
 */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, assert, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { log as runnerLog } from "../agents/embedded-agent-runner/logger.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../agents/embedded-agent-runner/run-state.js";
import { isEmbeddedAgentRunHandleActive } from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
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
  abortAgentHarnessRun,
  abortAndDrainAgentHarnessRun,
  AgentHarnessPreflightError,
  agentHarnessStructuredInput,
  attachModelProviderRequestTransport,
  buildAgentHarnessUserInputAnswers,
  classifyAgentHarnessTerminalOutcome,
  clearActiveEmbeddedRun,
  deliverAgentHarnessUserInputPrompt,
  formatAgentHarnessUserInputPrompt,
  getModelProviderRequestTransport,
  queueAgentHarnessMessage,
  setActiveEmbeddedRun,
  type AgentHarness,
  type AgentHarnessQuestionGatewayCall,
  type AgentHarnessAttemptParams,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessSideQuestionParams,
  type AgentHarnessSideQuestionParamsV2,
  type AgentHarnessSessionForkParams,
  type AgentHarnessV2,
  type EmbeddedRunAttemptParams,
  type EmbeddedRunAttemptParamsV2,
  type HarnessContextEngine,
} from "./agent-harness-runtime.js";

describe("classifyAgentHarnessTerminalOutcome", () => {
  function classify(overrides: Partial<Parameters<typeof classifyAgentHarnessTerminalOutcome>[0]>) {
    return classifyAgentHarnessTerminalOutcome({
      assistantTexts: [],
      reasoningText: "",
      planText: "",
      promptError: null,
      turnCompleted: true,
      ...overrides,
    });
  }

  it("accepts prepared literal NO_REPLY text as visible output", () => {
    expect(classify({ assistantTexts: ["NO_REPLY"] })).toBeUndefined();
  });

  it("treats whitespace-only assistant text as not visible", () => {
    expect(classify({ assistantTexts: ["  ", "\n\t"] })).toBe("empty");
  });

  it("prefers planning-only when both plan and reasoning text are present", () => {
    expect(
      classify({
        reasoningText: "I need to inspect the files.",
        planText: "I will inspect, patch, and test.",
      }),
    ).toBe("planning-only");
  });

  it("classifies a completed turn with reasoning text only as reasoning-only", () => {
    expect(classify({ reasoningText: "The answer depends on the current repository state." })).toBe(
      "reasoning-only",
    );
  });
});

describe("agent harness runtime SDK facade", () => {
  it("preserves the published failure-retention opt-in on attempt operations", () => {
    expectTypeOf<
      NonNullable<AgentHarnessAttemptParams["replyOperation"]>["retainFailureUntilComplete"]
    >().toEqualTypeOf<() => void>();
    expectTypeOf<
      NonNullable<EmbeddedRunAttemptParamsV2["replyOperation"]>["retainFailureUntilComplete"]
    >().toEqualTypeOf<() => void>();
  });

  it("exposes optional compaction progress without requiring it from legacy engines", () => {
    type CompactParams = Parameters<HarnessContextEngine["compact"]>[0];
    expectTypeOf<CompactParams["onProgress"]>().toEqualTypeOf<(() => void) | undefined>();
    expectTypeOf<Omit<CompactParams, "onProgress">>().toMatchTypeOf<CompactParams>();
  });

  it("exposes structured input through one frozen named runtime surface", () => {
    expect(Object.isFrozen(agentHarnessStructuredInput)).toBe(true);
    expect(Object.keys(agentHarnessStructuredInput).toSorted()).toEqual([
      "compileForm",
      "compileQuestions",
      "compileUrl",
      "isRecord",
      "run",
      "snapshot",
    ]);
  });

  it("keeps legacy harness implementations source-compatible while requiring capabilities in V2", () => {
    type SessionForkParamsV2 = Parameters<NonNullable<AgentHarnessV2["sessionForkV2"]>["fork"]>[0];
    const legacyHarness = {
      id: "legacy-test",
      label: "Legacy test harness",
      supports: () => ({ supported: true as const, priority: 1 }),
      runAttempt: async (_params: AgentHarnessAttemptParams) => {
        throw new Error("type-only legacy harness");
      },
      runSideQuestion: async (_params: AgentHarnessSideQuestionParams) => ({ text: "legacy" }),
    } satisfies AgentHarness;

    expectTypeOf(legacyHarness).toMatchTypeOf<AgentHarness>();
    expectTypeOf<AgentHarnessV2>().toMatchTypeOf<AgentHarness>();
    expectTypeOf<
      Omit<AgentHarnessAttemptParamsV2, "onSettledTurn">
    >().toMatchTypeOf<AgentHarnessAttemptParamsV2>();
    expectTypeOf<Omit<AgentHarnessAttemptParams, "hostCapabilities">>().toMatchTypeOf<
      Parameters<NonNullable<AgentHarness["finalizeSettledTurn"]>>[0]["attempt"]
    >();
    expectTypeOf<Omit<AgentHarnessAttemptParamsV2, "hostCapabilities">>().toMatchTypeOf<
      Parameters<NonNullable<AgentHarnessV2["finalizeSettledTurn"]>>[0]["attempt"]
    >();
    expectTypeOf<
      Parameters<NonNullable<AgentHarnessAttemptParamsV2["onSettledTurn"]>>[0]
    >().not.toHaveProperty("contextEngineTerminalAnchor");
    expectTypeOf<
      Omit<AgentHarnessSideQuestionParams, "hostCapabilities">
    >().toMatchTypeOf<AgentHarnessSideQuestionParams>();
    expectTypeOf<
      Omit<AgentHarnessAttemptParams, "hostCapabilities">
    >().toMatchTypeOf<AgentHarnessAttemptParams>();
    expectTypeOf<
      Omit<EmbeddedRunAttemptParams, "hostCapabilities">
    >().toMatchTypeOf<EmbeddedRunAttemptParams>();
    expectTypeOf<AgentHarnessAttemptParams["replyOperation"]>().toEqualTypeOf<
      EmbeddedRunAttemptParams["replyOperation"]
    >();
    expectTypeOf<
      Omit<AgentHarnessAttemptParamsV2, "hostCapabilities"> extends AgentHarnessAttemptParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Omit<EmbeddedRunAttemptParamsV2, "hostCapabilities"> extends EmbeddedRunAttemptParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      Omit<
        AgentHarnessSideQuestionParamsV2,
        "hostCapabilities"
      > extends AgentHarnessSideQuestionParamsV2
        ? true
        : false
    >().toEqualTypeOf<false>();

    expectTypeOf<
      Omit<SessionForkParamsV2, "assertCurrent">
    >().toEqualTypeOf<AgentHarnessSessionForkParams>();
    expectTypeOf<
      Omit<SessionForkParamsV2, "assertCurrent"> extends SessionForkParamsV2 ? true : false
    >().toEqualTypeOf<false>();

    // V1 injection remains supported inside a host-admitted harness attempt.
    type QueueOptions = Parameters<typeof queueAgentHarnessMessage>[2];
    const legacyInjection = {
      isAvailable: () => true,
      queueMessage: async (_text: string, _options?: QueueOptions) => {},
    };
    const legacyHandle = {
      queueMessage: legacyInjection.queueMessage,
      messageInjection: legacyInjection,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    } satisfies Parameters<typeof setActiveEmbeddedRun>[1];
    expectTypeOf(legacyHandle).toMatchTypeOf<Parameters<typeof setActiveEmbeddedRun>[1]>();
    expectTypeOf<
      Extract<keyof Parameters<typeof setActiveEmbeddedRun>[1], symbol>
    >().toEqualTypeOf<never>();
    expectTypeOf<Parameters<typeof setActiveEmbeddedRun>["length"]>().toEqualTypeOf<
      2 | 3 | 4 | 5
    >();
    expectTypeOf<ReturnType<typeof setActiveEmbeddedRun>>().toEqualTypeOf<
      ((reason?: string) => void) | undefined
    >();
    expectTypeOf(queueAgentHarnessMessage).returns.toEqualTypeOf<boolean>();
    type GuardedInjection = NonNullable<
      Parameters<typeof setActiveEmbeddedRun>[1]["messageInjectionV2"]
    >;
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

  it("exposes attached model request transport metadata helpers", () => {
    const model = attachModelProviderRequestTransport(
      { id: "gpt-test", provider: "custom-openai" },
      { auth: { mode: "header", headerName: "x-api-key", value: "secret" } },
    );

    expect(getModelProviderRequestTransport(model)).toEqual({
      auth: { mode: "header", headerName: "x-api-key", value: "secret" },
    });
  });
});

describe("agent harness active-run SDK controls", () => {
  afterEach(() => embeddedRunsTesting.resetActiveEmbeddedRuns());

  it("retires ownerless diagnostics without letting prior cleanup erase a successor", () => {
    const ref = { sessionId: "sdk-diagnostic-cleanup" };
    const priorCleanup = setActiveEmbeddedRun(
      ref.sessionId,
      createEmbeddedRunHandle({ runId: "prior-diagnostic-run" }),
    );
    const successorCleanup = setActiveEmbeddedRun(
      ref.sessionId,
      createEmbeddedRunHandle({ runId: "successor-diagnostic-run" }),
    );
    try {
      expect(priorCleanup).toBeTypeOf("function");
      expect(successorCleanup).toBeTypeOf("function");
      expect(diagnosticActivity.getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
        activeWorkKind: "embedded_run",
        hasActiveEmbeddedRun: true,
      });

      priorCleanup?.();
      expect(diagnosticActivity.getDiagnosticSessionActivitySnapshot(ref)).toMatchObject({
        activeWorkKind: "embedded_run",
        hasActiveEmbeddedRun: true,
      });

      successorCleanup?.();
      const settled = diagnosticActivity.getDiagnosticSessionActivitySnapshot(ref);
      expect(settled.activeWorkKind).toBeUndefined();
      expect(settled.hasActiveEmbeddedRun).toBeUndefined();
    } finally {
      priorCleanup?.();
      successorCleanup?.();
      diagnosticActivity.resetDiagnosticRunActivityForTest();
    }
  });

  it("rejects a session-keyed registration without host admission", () => {
    const handle = createEmbeddedRunHandle();
    let failure: unknown;
    try {
      setActiveEmbeddedRun("unadmitted", handle, "agent:main:unadmitted");
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
    const operation = registerTestEmbeddedRun(
      "sdk-turn",
      createEmbeddedRunHandle({ queueMessage }),
      "agent:main:sdk-turn",
    );
    expect(queueAgentHarnessMessage("sdk-turn", "steer")).toBe(true);
    await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
    const waiting = reserveSessionControllerSource("agent:main:sdk-turn", {
      policy: { mode: "followup" },
    });
    try {
      expect(abortAgentHarnessRun("sdk-turn")).toBe(true);
      expect(operation.result).toMatchObject({ kind: "aborted", code: "aborted_by_user" });
      expect(waiting.retirementRequested).toBeUndefined();
    } finally {
      retireSessionControllerInput(waiting);
    }
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
    const operation = registerTestEmbeddedRun(
      "sdk-unconfirmed",
      createEmbeddedRunHandle({ queueMessage, guarded: true }),
      "agent:main:sdk-unconfirmed",
    );
    try {
      expect(queueAgentHarnessMessage("sdk-unconfirmed", "synthetic private input")).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      finish.resolve();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          "queue message outcome unconfirmed: sessionId=sdk-unconfirmed; inspect the conversation before retrying",
        ),
      );
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(operation.abortSignal.aborted).toBe(false);
    } finally {
      finish.resolve();
      operation.complete();
      warn.mockRestore();
    }
  });

  it.each(["legacy handle", "V1 sink", "V2 sink"] as const)(
    "queues sessionless native work through its available %s behind an alias-only effect",
    async (kind) => {
      const queueMessage = vi.fn(
        async (_text: string, _options?: Parameters<typeof queueAgentHarnessMessage>[2]) => {},
      );
      const abort = vi.fn();
      const handle: Parameters<typeof setActiveEmbeddedRun>[1] = {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort,
        ...(kind === "V1 sink"
          ? { messageInjection: { isAvailable: () => true, queueMessage } }
          : {}),
        ...(kind === "V2 sink"
          ? {
              messageInjectionV2: {
                version: 2 as const,
                isAvailable: () => true,
                queueMessage: async (text, options, assertCurrent) => {
                  assertCurrent();
                  await queueMessage(text, options);
                },
              },
            }
          : {}),
      };
      const effect = await beginSessionEffect({
        scope: "/tmp/sdk-detached-store",
        identities: ["sdk-detached"],
      });
      try {
        setActiveEmbeddedRun("sdk-detached", handle);
        expect(queueAgentHarnessMessage("sdk-detached", "steer")).toBe(true);
        await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
        expect(queueMessage.mock.calls[0]?.[0]).toBe("steer");
      } finally {
        effect.release();
      }
      expect(abortAgentHarnessRun("sdk-detached")).toBe(true);
      expect(abort).toHaveBeenCalledOnce();
    },
  );

  it.each(["single", "all", "compacting", "drain"] as const)(
    "cancels exact detached native work behind an alias-only effect through %s",
    async (mode) => {
      vi.useFakeTimers();
      const sessionId = "sdk-detached-cancel";
      const effect = await beginSessionEffect({
        scope: "/tmp/sdk-detached-cancel-store",
        identities: [sessionId],
      });
      const abort = vi.fn();
      const handle = createEmbeddedRunHandle({ abort, isCompacting: true });
      const cleanup = setActiveEmbeddedRun(sessionId, handle);
      let successorCleanup: ReturnType<typeof setActiveEmbeddedRun>;
      try {
        expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(false);
        if (mode === "drain") {
          let returned = false;
          const draining = abortAndDrainAgentHarnessRun({ sessionId, settleMs: 100 }).then(
            (result) => {
              returned = true;
              return result;
            },
          );
          await vi.advanceTimersByTimeAsync(0);
          expect(abort).toHaveBeenCalledOnce();
          expect(returned).toBe(false);
          const successorAbort = vi.fn();
          successorCleanup = setActiveEmbeddedRun(
            sessionId,
            createEmbeddedRunHandle({ abort: successorAbort }),
          );
          cleanup?.();
          await expect(draining).resolves.toEqual({
            aborted: true,
            drained: true,
            forceCleared: false,
          });
          expect(successorAbort).not.toHaveBeenCalled();
        } else {
          expect(
            mode === "single"
              ? abortAgentHarnessRun(sessionId)
              : abortAgentHarnessRun(undefined, { mode }),
          ).toBe(true);
          expect(abort).toHaveBeenCalledOnce();
        }
      } finally {
        cleanup?.();
        successorCleanup?.();
        effect.release();
        vi.useRealTimers();
      }
    },
  );

  it.each(["single", "all", "compacting", "drain"] as const)(
    "refuses a detached %s cancellation replaced during its abortability probe",
    async (mode) => {
      const sessionId = "sdk-detached-cancel-replaced";
      const effect = await beginSessionEffect({
        scope: "/tmp/sdk-detached-cancel-replaced-store",
        identities: [sessionId],
      });
      const abort = vi.fn();
      const successorAbort = vi.fn();
      let successorCleanup: ReturnType<typeof setActiveEmbeddedRun>;
      const isAbortable = vi.fn(() => {
        successorCleanup = setActiveEmbeddedRun(
          sessionId,
          createEmbeddedRunHandle({ abort: successorAbort }),
        );
        cleanup?.();
        return true;
      });
      const cleanup = setActiveEmbeddedRun(sessionId, {
        ...createEmbeddedRunHandle({ abort, isCompacting: true }),
        isAbortable,
      });
      try {
        if (mode === "drain") {
          await expect(abortAndDrainAgentHarnessRun({ sessionId })).resolves.toEqual({
            aborted: false,
            drained: true,
            forceCleared: false,
          });
        } else {
          expect(
            mode === "single"
              ? abortAgentHarnessRun(sessionId)
              : abortAgentHarnessRun(undefined, { mode }),
          ).toBe(false);
        }
        expect(isAbortable).toHaveBeenCalledOnce();
        expect(abort).not.toHaveBeenCalled();
        expect(successorAbort).not.toHaveBeenCalled();
      } finally {
        cleanup?.();
        successorCleanup?.();
        effect.release();
      }
    },
  );

  it.each(["single", "all", "compacting", "drain"] as const)(
    "keeps active controller ownership ahead of detached work during %s cancellation",
    async (mode) => {
      const sessionId = "sdk-detached-cancel-controller";
      const abort = vi.fn();
      const cleanup = setActiveEmbeddedRun(
        sessionId,
        createEmbeddedRunHandle({ abort, isCompacting: true }),
      );
      const operation = createReplyOperation({
        sessionKey: "agent:main:sdk-cancel-controller",
        sessionId,
        resetTriggered: false,
      });
      try {
        const result =
          mode === "drain"
            ? abortAndDrainAgentHarnessRun({ sessionId })
            : mode === "single"
              ? abortAgentHarnessRun(sessionId)
              : abortAgentHarnessRun(undefined, { mode });
        expect(abort).not.toHaveBeenCalled();
        expect(operation.abortSignal.aborted).toBe(mode !== "compacting");
        operation.complete();
        if (mode === "drain") {
          await expect(result).resolves.toEqual({
            aborted: true,
            drained: true,
            forceCleared: false,
          });
        } else {
          expect(result).toBe(mode !== "compacting");
        }
      } finally {
        operation.complete();
        cleanup?.();
      }
    },
  );

  it.each(["single", "drain"] as const)(
    "rejects ambiguous controllers before selecting detached work for %s cancellation",
    async (mode) => {
      const sessionId = "sdk-detached-cancel-ambiguous";
      const abort = vi.fn();
      const cleanup = setActiveEmbeddedRun(sessionId, createEmbeddedRunHandle({ abort }));
      const first = createReplyOperation({
        sessionKey: "agent:main:sdk-cancel-first",
        sessionId,
        resetTriggered: false,
      });
      const second = createReplyOperation({
        sessionKey: "agent:main:sdk-cancel-second",
        sessionId,
        resetTriggered: false,
      });
      try {
        if (mode === "drain") {
          await expect(abortAndDrainAgentHarnessRun({ sessionId })).rejects.toThrow();
        } else {
          expect(() => abortAgentHarnessRun(sessionId)).toThrow();
        }
        expect(abort).not.toHaveBeenCalled();
        expect(first.abortSignal.aborted).toBe(false);
        expect(second.abortSignal.aborted).toBe(false);
      } finally {
        first.complete();
        second.complete();
        cleanup?.();
      }
    },
  );

  it.each(["not streaming", "stopped", "V1 unavailable", "V2 unavailable", "stale"] as const)(
    "refuses a sessionless native sink that is %s",
    async (state) => {
      const queueMessage = vi.fn(async () => {});
      const handle: Parameters<typeof setActiveEmbeddedRun>[1] = {
        queueMessage,
        isStreaming: () => state !== "not streaming",
        isCompacting: () => false,
        abort: () => {},
        ...(state === "stopped" ? { isStopped: () => true } : {}),
        ...(state === "V1 unavailable"
          ? { messageInjection: { isAvailable: () => false, queueMessage } }
          : {}),
        ...(state === "V2 unavailable"
          ? { messageInjectionV2: { version: 2 as const, isAvailable: () => false, queueMessage } }
          : {}),
      };
      const effect = await beginSessionEffect({
        scope: "/tmp/sdk-unavailable-store",
        identities: ["sdk-unavailable"],
      });
      const activity =
        state === "stale"
          ? vi.spyOn(diagnosticActivity, "getDiagnosticSessionActivitySnapshot").mockReturnValue({
              lastProgressAgeMs: 11 * 60_000,
            })
          : undefined;
      try {
        setActiveEmbeddedRun("sdk-unavailable", handle);
        expect(queueAgentHarnessMessage("sdk-unavailable", "steer")).toBe(false);
        expect(queueMessage).not.toHaveBeenCalled();
      } finally {
        activity?.mockRestore();
        effect.release();
      }
    },
  );

  it.each(["V1", "V2"] as const)(
    "checks caller authority before dispatching to a sessionless %s sink",
    (kind) => {
      const queueMessage = vi.fn(async () => {});
      const guardedQueueMessage: NonNullable<
        Parameters<typeof setActiveEmbeddedRun>[1]["messageInjectionV2"]
      >["queueMessage"] = (_text, _options, assertCurrent) => {
        assertCurrent();
        return queueMessage();
      };
      const handle: Parameters<typeof setActiveEmbeddedRun>[1] = {
        queueMessage,
        isStreaming: () => true,
        isCompacting: () => false,
        abort: () => {},
        ...(kind === "V1"
          ? { messageInjection: { isAvailable: () => true, queueMessage } }
          : {
              messageInjectionV2: {
                version: 2 as const,
                isAvailable: () => true,
                queueMessage: guardedQueueMessage,
              },
            }),
      };
      setActiveEmbeddedRun("sdk-revoked-caller", handle);
      const options = {
        steeringMode: "all" as const,
        assertCurrent: () => {
          throw new Error("caller authority revoked");
        },
      };
      expect(() => queueAgentHarnessMessage("sdk-revoked-caller", "steer", options)).toThrow(
        kind === "V1"
          ? "caller authority revoked"
          : "Message injection authority is no longer current",
      );
      expect(queueMessage).not.toHaveBeenCalled();
    },
  );

  it("does not substitute a raw fingerprint for sessionless overlay projection authority", () => {
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun("sdk-overlay", {
      queueMessage,
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
      toolAuthorityFingerprint: "current-authority",
    });
    const options = {
      isInboundUserMessage: true,
      toolAuthorityFingerprint: "current-authority",
      toolAuthorityOverlay: { senderIsOwner: false, disableTools: false, traceAuthorized: false },
    };
    expect(queueAgentHarnessMessage("sdk-overlay", "steer", options)).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("revokes sessionless V2 injection when its exact native registration is replaced", () => {
    let retained: (() => void) | undefined;
    const handle: Parameters<typeof setActiveEmbeddedRun>[1] = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (_text, _options, assertCurrent) => {
          retained = assertCurrent;
        },
      },
    };
    const firstCleanup = expectDefined(
      setActiveEmbeddedRun("sdk-replaced", handle),
      "first native registration",
    );
    expect(queueAgentHarnessMessage("sdk-replaced", "first")).toBe(true);
    const firstAssertion = expectDefined(retained, "first injection authority");
    expect(firstAssertion).not.toThrow();

    const secondCleanup = expectDefined(
      setActiveEmbeddedRun("sdk-replaced", handle),
      "second native registration",
    );
    firstCleanup();
    expect(firstAssertion).toThrow("Message injection authority is no longer current");
    expect(queueAgentHarnessMessage("sdk-replaced", "second")).toBe(true);
    const secondAssertion = expectDefined(retained, "second injection authority");
    expect(secondAssertion).not.toThrow();
    secondCleanup();
    expect(secondAssertion).toThrow("Message injection authority is no longer current");
  });

  it.each(["human", "runtime"] as const)(
    "preserves an exact detached %s wait behind an alias-only effect",
    async (kind) => {
      const sessionId = `sdk-protected-${kind}`;
      const instance = createOperationalRunInstanceRef(`${sessionId}-run`);
      const authority = claimAgentRunDelegatedAuthority(instance);
      const effect = await beginSessionEffect({
        scope: "/tmp/sdk-protected-store",
        identities: [sessionId],
      });
      const activity = vi
        .spyOn(diagnosticActivity, "getDiagnosticSessionActivitySnapshot")
        .mockReturnValue({ lastProgressAgeMs: 11 * 60_000 });
      const queueMessage = vi.fn(async () => {});
      let runtimeWaiting = kind === "runtime";
      let cleanup: ReturnType<typeof setActiveEmbeddedRun> = undefined;
      let releaseWait: ((resolved: boolean) => void) | undefined;
      try {
        cleanup = await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: `agent:main:${sessionId}`,
            operationalRunInstance: instance,
          },
          () =>
            setActiveEmbeddedRun(sessionId, {
              runId: instance.runId,
              queueMessage,
              isStreaming: () => true,
              isCompacting: () => false,
              ownsLiveness: () => runtimeWaiting,
              abort: () => {},
            }),
        );
        if (kind === "human") {
          releaseWait = expectDefined(
            registerActiveEmbeddedRunHumanInputWait(authority, () => true),
            "exact detached human-input wait",
          );
        }
        expect(queueAgentHarnessMessage(sessionId, "answer")).toBe(true);
        await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledOnce());
        releaseWait?.(false);
        runtimeWaiting = false;
        expect(queueAgentHarnessMessage(sessionId, "stale followup")).toBe(false);
        expect(queueMessage).toHaveBeenCalledOnce();
      } finally {
        releaseWait?.(false);
        cleanup?.();
        releaseAgentRunDelegatedAuthority(authority);
        effect.release();
        activity.mockRestore();
      }
    },
  );

  it("revokes retained detached injection when a controller takes the same ID", () => {
    let retained: (() => void) | undefined;
    const handle: Parameters<typeof setActiveEmbeddedRun>[1] = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async (_text, _options, assertCurrent) => {
          retained = assertCurrent;
        },
      },
    };
    setActiveEmbeddedRun("sdk-controller-takeover", handle);
    expect(queueAgentHarnessMessage("sdk-controller-takeover", "first")).toBe(true);
    const assertion = expectDefined(retained, "detached injection authority");
    expect(assertion).not.toThrow();
    const operation = registerTestEmbeddedRun(
      "sdk-controller-takeover",
      createEmbeddedRunHandle(),
      "agent:main:sdk-controller-takeover",
    );
    try {
      expect(assertion).toThrow("Message injection authority is no longer current");
    } finally {
      operation.complete();
    }
  });

  it("keeps retained cleanup bound to its exact registration", () => {
    const handle = createEmbeddedRunHandle();
    const priorCleanup = setActiveEmbeddedRun("sdk-cleanup", handle);
    const currentCleanup = expectDefined(
      setActiveEmbeddedRun("sdk-cleanup", handle),
      "current registration cleanup",
    );
    assert.isFunction(priorCleanup);
    assert.isFunction(currentCleanup);
    clearActiveEmbeddedRun(
      "sdk-cleanup",
      handle,
      undefined,
      undefined,
      "old_cleanup",
      priorCleanup,
    );
    expect(isEmbeddedAgentRunHandleActive("sdk-cleanup")).toBe(true);
    currentCleanup("current_cleanup");
    expect(isEmbeddedAgentRunHandleActive("sdk-cleanup")).toBe(false);
  });
});

describe("agent harness user input helpers", () => {
  it("formats prompts and delivers through blocking replies first", async () => {
    const onBlockReply = vi.fn();

    await deliverAgentHarnessUserInputPrompt(
      { onBlockReply },
      [
        {
          id: "mode",
          header: "Mode",
          question: "Pick a mode",
          isOther: true,
          options: [{ label: "Deep", description: "Use more context" }],
        },
      ],
      { intro: "Runtime needs input:" },
    );

    expect(onBlockReply).toHaveBeenCalledWith({
      text: [
        "Runtime needs input:",
        "",
        "Mode",
        "Pick a mode",
        "1. Deep - Use more context",
        "Other: reply with your own answer.",
      ].join("\n"),
    });
  });

  it("keeps a comma-containing option label as one multi-select answer", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          {
            id: "region",
            header: "Region",
            question: "Which region should deploy?",
            multiSelect: true,
            isOther: true,
            options: [{ label: "Frankfurt, Germany" }, { label: "Dublin, Ireland" }],
          },
        ],
        "Frankfurt, Germany",
      ),
    ).toEqual({ answers: { region: { answers: ["Frankfurt, Germany"] } } });
  });

  it("supports runtime-specific text formatting", () => {
    expect(
      formatAgentHarnessUserInputPrompt(
        [
          {
            id: "answer",
            header: "Header",
            question: "a < b",
          },
        ],
        { formatText: (text) => text.replaceAll("<", "&lt;") },
      ),
    ).toContain("a &lt; b");
  });

  it("preserves blank fallback lines so skipped answers stay aligned", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          { id: "q1", header: "Q1", question: "First?" },
          { id: "q2", header: "Q2", question: "Second?" },
          { id: "q3", header: "Q3", question: "Third?" },
        ],
        "\nyes\nno",
      ),
    ).toEqual({
      answers: {
        q1: { answers: [] },
        q2: { answers: ["yes"] },
        q3: { answers: ["no"] },
      },
    });
  });
});
