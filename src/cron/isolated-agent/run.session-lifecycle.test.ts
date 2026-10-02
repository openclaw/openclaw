import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, beforeEach, describe, expect, it, vi, assert } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolvePreparedRunAdmission } from "../../agents/admitted-run-context.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import { prepareEmbeddedAttemptStream } from "../../agents/embedded-agent-runner/run/attempt-stream-prepare.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { clearActiveEmbeddedRun } from "../../agents/embedded-agent-runner/runs.js";
import { createStubSessionHarness } from "../../agents/embedded-agent-subscribe.e2e-harness.js";
import { FailoverError } from "../../agents/failover-error.js";
import { GENERIC_EXTERNAL_RUN_FAILURE_TEXT } from "../../agents/failover/user-copy.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../../gateway/server-chat-state.js";
import {
  createAgentEventHandler,
  type AgentEventHandlerOptions,
} from "../../gateway/server-chat.js";
import { onAgentRuntimeEvent } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContextOwnership,
} from "../../infra/agent-run-registry.js";
import { createDiagnosticEmbeddedRunOwner } from "../../logging/diagnostic-run-activity.js";
import * as diagnostic from "../../logging/diagnostic.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  dispatchCronDeliveryMock,
  getCliSessionBindingMock,
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  callGatewayMock,
  makeCronSession,
  makeCronSessionEntry,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  preflightCronModelProviderMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  resolveAllowedModelRefMock,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  resolveDeliveryTargetMock,
  runEmbeddedAgentMock,
  runCliAgentMock,
  runWithModelFallbackMock,
  resolveConfiguredModelRefMock,
  resolveAgentModelFallbacksOverrideMock,
} from "./run.test-harness.js";

// Persistent cron session tests cover lifecycle admission and mutation races.

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const accessor = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
  "../../config/sessions/session-accessor.js",
);
const inMemoryStorePath = "/tmp/store.json";

function makePersistentCronParams(sessionKey: string) {
  return makeIsolatedAgentParamsFixture({
    agentId: "main",
    sessionKey,
    job: makeIsolatedAgentJobFixture({
      // Bind the run to the persistent session key so the run operates on it
      // directly; `current`/`isolated` targets derive a detached `cron:<id>`
      // run session instead, which the lifecycle claim assertions do not target.
      sessionTarget: `session:${sessionKey}`,
      delivery: { mode: "none" },
    }),
  });
}

function seedPersistentSession(sessionKey: string, sessionId: string) {
  const initialSessionEntry = makeCronSessionEntry({ sessionId });
  resolveCronSessionMock.mockReturnValue(
    makeCronSession({
      store: { [sessionKey]: { ...initialSessionEntry } },
      initialSessionEntry,
      isNewSession: false,
      sessionEntry: { ...initialSessionEntry },
    }),
  );
  loadSessionEntryMock.mockReturnValue({ ...initialSessionEntry });
  return initialSessionEntry;
}

describe("runCronIsolatedAgentTurn session lifecycle", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cron-prompt-provenance-");
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  it("persists current-session CLI prompt provenance in the detached transcript", async () => {
    const dir = sessionDirs.make();
    const sessionId = "cron-provenance-run";
    const jobId = "daily-monitor";
    const sourceSessionKey = "agent:main:main";
    const runSessionKey = `agent:main:cron:${jobId}:run:${sessionId}`;
    const storePath = path.join(dir, "openclaw-agent.sqlite");
    const sourceEntry = { sessionId: "source-session", updatedAt: 1 };
    await accessor.replaceSessionEntry(
      { agentId: "main", sessionKey: sourceSessionKey, storePath },
      sourceEntry,
    );
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        storePath,
        store: { [sourceSessionKey]: sourceEntry },
        sessionEntry: makeCronSessionEntry({ sessionId }),
      }),
    );
    isCliProviderMock.mockReturnValue(true);
    let modelPrompt: string | undefined;
    runCliAgentMock.mockImplementationOnce(
      async (runParams: {
        prompt: string;
        userTurnTranscriptRecorder: UserTurnTranscriptRecorder;
      }) => {
        modelPrompt = runParams.prompt;
        await runParams.userTurnTranscriptRecorder.persistApproved({ cwd: dir });
        return { payloads: [{ text: "Monitor complete" }], meta: { agentMeta: {} } };
      },
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: `cron:${jobId}`,
        job: makeIsolatedAgentJobFixture({
          id: jobId,
          name: "Daily monitor",
          sessionTarget: "current",
          sessionKey: sourceSessionKey,
          payload: { kind: "agentTurn", message: "Read REFRESH.md.\n    Keep indentation." },
        }),
      }),
    );

    expect(result.status).toBe("ok");
    expect(result.sessionKey).toBe(runSessionKey);
    expect(modelPrompt).toContain(
      `[cron:${jobId} Daily monitor] Read REFRESH.md.\n    Keep indentation.\nCurrent time:`,
    );
    const entries = (
      await accessor.loadTranscriptEvents({
        agentId: "main",
        sessionId,
        sessionKey: runSessionKey,
        storePath,
      })
    ).filter((entry) => asOptionalRecord(entry)?.type === "message");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: {
        role: "user",
        content: modelPrompt,
        provenance: {
          kind: "internal_system",
          sourceTool: "cron",
          sourcePromptPrefix: `[cron:${jobId} Daily monitor]`,
          jobId,
          runId: sessionId,
          sourceSessionKey: runSessionKey,
        },
      },
    });
    expect(
      (
        await accessor.loadTranscriptEvents({
          agentId: "main",
          sessionId: sourceEntry.sessionId,
          sessionKey: sourceSessionKey,
          storePath,
        })
      ).filter((entry) => asOptionalRecord(entry)?.type === "message"),
    ).toEqual([]);
  });

  it.each(["base", "continuation", "interrupted clear"] as const)(
    "seals only accepted CLI continuity at %s settlement",
    async (failurePoint) => {
      const dir = sessionDirs.make();
      const target = {
        agentId: "main",
        sessionId: `binding-${failurePoint}`,
        sessionKey: "agent:main:cron:binding-settlement",
        storePath: path.join(dir, "openclaw-agent.sqlite"),
      };
      const previousBinding = { sessionId: "previous-native", authProfileId: "anthropic:cli" };
      const nextBinding = { ...previousBinding, sessionId: "next-native" };
      const clearing = failurePoint === "interrupted clear";
      await accessor.replaceSessionEntry(target, {
        sessionId: target.sessionId,
        lifecycleRevision: "binding-revision",
        updatedAt: 1,
        cliSessionBindings: { "claude-cli": previousBinding },
      });
      await accessor.appendTranscriptMessage(target, {
        message: { role: "user", content: "Synthetic cron continuity prompt" },
      });
      const initialSessionEntry = accessor.loadSessionEntry(target);
      if (!initialSessionEntry) {
        throw new Error("Expected the persisted CLI parent before admission");
      }
      resolveCronSessionMock.mockReturnValue(
        makeCronSession({
          storePath: target.storePath,
          store: { [target.sessionKey]: { ...initialSessionEntry } },
          initialSessionEntry,
          isNewSession: false,
          lifecycleRevision: "binding-revision",
          sessionEntry: { ...initialSessionEntry },
        }),
      );
      loadSessionEntryMock.mockImplementation(() => accessor.loadSessionEntry(target));
      isCliProviderMock.mockImplementation((provider) => provider === "claude-cli");
      resolveAllowedModelRefMock.mockReturnValue({
        ref: { provider: "claude-cli", model: "claude-sonnet-4-6" },
      });
      getCliSessionBindingMock.mockReturnValue(
        failurePoint === "base" ? { sessionId: previousBinding.sessionId } : previousBinding,
      );
      const controller = new AbortController();
      let interrupted = false;
      const interrupt = () => {
        interrupted = true;
        controller.abort(new Error("Synthetic binding commit interruption"));
      };
      runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
        expect(params.cliSessionId).toBe(previousBinding.sessionId);
        return {
          payloads: [{ text: "Synthetic cron answer" }],
          meta: {
            durationMs: 1,
            executionTrace: { runner: "cli" },
            agentMeta: clearing
              ? { sessionId: "", clearCliSessionBinding: true }
              : { sessionId: nextBinding.sessionId, cliSessionBinding: nextBinding },
          },
        };
      });
      const patchWithAbort: typeof accessor.patchSessionEntryCore = (scope, update, options) => {
        const assertCommitAllowed = options?.assertCommitAllowed;
        return accessor.patchSessionEntryCore(scope, update, {
          ...options,
          ...(assertCommitAllowed
            ? {
                assertCommitAllowed: () => {
                  const isBase = scope.sessionKey === target.sessionKey;
                  if ((failurePoint !== "continuation") === isBase) {
                    interrupt();
                  }
                  assertCommitAllowed();
                },
              }
            : {}),
        });
      };
      patchSessionEntryMock.mockImplementation(patchWithAbort);

      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          agentId: "main",
          // The scheduler's cron key enables the hidden exact-run continuation.
          sessionKey: "cron:binding-settlement",
          job: makeIsolatedAgentJobFixture({
            sessionTarget: `session:${target.sessionKey}`,
            delivery: { mode: "none" },
            payload: {
              kind: "agentTurn",
              message: "Synthetic cron continuity prompt",
              model: "claude-cli/claude-sonnet-4-6",
            },
          }),
          abortSignal: controller.signal,
        }),
      );

      expect(interrupted).toBe(true);
      expect(result.status).toBe("error");
      expect(runCliAgentMock).toHaveBeenCalledOnce();
      const acceptedBinding = clearing
        ? undefined
        : failurePoint === "base"
          ? previousBinding
          : nextBinding;
      expect(accessor.loadSessionEntry(target)?.cliSessionBindings?.["claude-cli"]).toEqual(
        acceptedBinding,
      );
      const continuation = accessor.loadSessionEntry({
        ...target,
        sessionKey: `${target.sessionKey}:run:${target.sessionId}`,
      });
      expect(continuation?.cronRunContinuation?.phase).toBe("ready");
      expect(continuation?.cliSessionBindings?.["claude-cli"]).toEqual(acceptedBinding);
    },
  );

  it.each(["rotates", "is deleted"])(
    "rejects a session that %s before async setup",
    async (change) => {
      const sessionKey = "agent:main:main";
      const rotated = change === "rotates";
      const initialSessionEntry = seedPersistentSession(
        sessionKey,
        rotated ? "session-before-setup" : "persistent-session",
      );
      loadSessionEntryMock.mockReturnValue(
        rotated ? { ...initialSessionEntry, sessionId: "session-after-setup" } : undefined,
      );
      await expect(
        runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey)),
      ).resolves.toMatchObject({
        status: "error",
        error: `Session "${sessionKey}" changed while starting work. Retry.`,
        admissionDisposition: "session-conflict",
      });
      if (rotated) {
        expect(preflightCronModelProviderMock).not.toHaveBeenCalled();
      }
      expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    },
  );

  it("protects the isolated cron session throughout async model preparation", async () => {
    const sessionKey = "agent:main:cron:test-job";
    const initialSessionEntry = makeCronSessionEntry({
      lifecycleRevision: "initial-revision",
      sessionId: "previous-session",
    });
    const sessionEntry = makeCronSessionEntry({ sessionId: "isolated-session" });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        store: { [sessionKey]: { ...initialSessionEntry } },
        initialSessionEntry,
        sessionEntry,
      }),
    );
    loadSessionEntryMock.mockImplementation((_storePath, currentSessionKey) =>
      currentSessionKey === sessionKey ? initialSessionEntry : undefined,
    );
    const preflightStarted = createDeferred();
    const releasePreflight = createDeferred();
    preflightCronModelProviderMock.mockImplementationOnce(async () => {
      preflightStarted.resolve();
      await releasePreflight.promise;
      return { status: "available" };
    });

    const run = runCronIsolatedAgentTurn(
      makeIsolatedAgentParamsFixture({
        agentId: "main",
        sessionKey: "cron:test-job",
        job: makeIsolatedAgentJobFixture({ delivery: { mode: "none" } }),
      }),
    );
    await preflightStarted.promise;
    const sessionIsProtectedDuringPreflight = isSessionWorkAdmissionActive(inMemoryStorePath, [
      sessionKey,
      "previous-session",
      "isolated-session",
    ]);
    releasePreflight.resolve();

    expect(sessionIsProtectedDuringPreflight).toBe(true);
    await expect(run).resolves.toMatchObject({ status: "ok" });
    expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(1);
    expect(patchSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey }),
      expect.any(Function),
      expect.objectContaining({
        fallbackEntry: expect.objectContaining({ sessionId: "isolated-session" }),
      }),
    );
  });

  it("interrupts persistent cron work and waits for its lifecycle lease to release", async () => {
    const sessionKey = "agent:main:telegram:direct:42";
    const sessionId = "shared-session";
    const admissionScope = { scope: inMemoryStorePath, identities: [sessionKey, sessionId] };
    seedPersistentSession(sessionKey, sessionId);
    const runnerStarted = createDeferred();
    const lifecycleInterrupted = createDeferred();
    const releaseRunner = createDeferred();
    runEmbeddedAgentMock.mockImplementationOnce(
      async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        runnerStarted.resolve();
        if (abortSignal?.aborted) {
          lifecycleInterrupted.resolve();
        } else {
          abortSignal?.addEventListener("abort", () => lifecycleInterrupted.resolve(), {
            once: true,
          });
        }
        await releaseRunner.promise;
        return {
          payloads: [],
          meta: { aborted: true, agentMeta: {} },
        };
      },
    );

    const run = runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey));
    await runnerStarted.promise;
    let mutationCommitted = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      ...admissionScope,
      prepare: async () => {
        await interruptSessionWorkAdmissions(admissionScope);
      },
      run: async () => {
        mutationCommitted = true;
      },
    });

    await lifecycleInterrupted.promise;
    expect(mutationCommitted).toBe(false);
    releaseRunner.resolve();

    const [result] = await Promise.all([run, mutation]);
    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "agent run aborted for restart | OPENCLAW_RESTART_ABORT",
      }),
    );
    expect(mutationCommitted).toBe(true);
  });

  it("releases admission when final lifecycle marking fails", async () => {
    const sessionKey = "agent:main:cron:final-lifecycle-failure";
    const sessionId = "final-lifecycle-session";
    seedPersistentSession(sessionKey, sessionId);
    const originalLogSessionStateChange = diagnostic.logSessionStateChange;
    const logSessionStateChangeSpy = vi
      .spyOn(diagnostic, "logSessionStateChange")
      .mockImplementation((params) => {
        if (params.state === "idle") {
          throw new Error("simulated final lifecycle failure");
        }
        return originalLogSessionStateChange(params);
      });

    try {
      await expect(runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey))).rejects.toThrow(
        "simulated final lifecycle failure",
      );
      expect(isSessionWorkAdmissionActive(inMemoryStorePath, [sessionKey, sessionId])).toBe(false);
    } finally {
      logSessionStateChangeSpy.mockRestore();
    }
  });

  it.each(["silent", "best-effort", "execution error", "presentation warning"])(
    "settles isolated %s cleanup after releasing its lease",
    async (outcome) => {
      dispatchCronDeliveryMock.mockImplementationOnce(
        (await vi.importActual<typeof import("./delivery-dispatch.js")>("./delivery-dispatch.js"))
          .dispatchCronDelivery,
      );
      const bestEffort = outcome !== "silent";
      const failed = outcome === "execution error" || outcome === "presentation warning";
      resolveCronPayloadOutcomeMock.mockImplementation(
        (await vi.importActual<typeof import("./helpers.js")>("./helpers.js"))
          .resolveCronPayloadOutcome,
      );
      resolveCronDeliveryPlanMock.mockReturnValue({
        requested: true,
        mode: "announce",
      });
      resolveDeliveryTargetMock.mockResolvedValue({
        ok: false,
        mode: "implicit",
        error: new Error("delivery target unavailable"),
      });
      runEmbeddedAgentMock.mockResolvedValue({
        payloads: [
          { text: outcome === "silent" ? "NO_REPLY" : "Report" },
          ...(outcome === "presentation warning"
            ? [
                setReplyPayloadMetadata(
                  { text: "⚠️ Message failed", isError: true },
                  { toolErrorWarning: { toolName: "message" } },
                ),
              ]
            : []),
        ],
        meta: {
          agentMeta: {},
          ...(outcome === "silent" ? { finalAssistantRawText: "NO_REPLY" } : {}),
          ...(outcome === "execution error"
            ? { error: { kind: "provider_error", message: "provider failed" } }
            : {}),
        },
      });
      const sessionKey = "agent:main:cron:test-job";
      const sessionId = "isolated-session";
      const storePath = inMemoryStorePath;
      resolveCronSessionMock.mockReturnValue(
        makeCronSession({
          sessionEntry: makeCronSessionEntry({ sessionId }),
        }),
      );
      let admissionActiveDuringDelete = true;
      callGatewayMock.mockImplementationOnce(async () => {
        admissionActiveDuringDelete = isSessionWorkAdmissionActive(storePath, [
          sessionKey,
          sessionId,
        ]);
        return { ok: true, deleted: true };
      });

      const result = await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          agentId: "main",
          sessionKey: "cron:test-job",
          job: makeIsolatedAgentJobFixture({
            deleteAfterRun: true,
            delivery: { mode: "announce", bestEffort },
          }),
        }),
      );

      expect(result.status).toBe(failed ? "error" : "ok");
      expect(callGatewayMock).toHaveBeenCalledTimes(failed ? 0 : 1);
      if (!failed) {
        expect(admissionActiveDuringDelete).toBe(false);
      }
      expect(isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId])).toBe(false);
    },
  );

  it("marks a final lifecycle claim conflict as post-execution (#108428)", async () => {
    const sessionKey = "agent:main:main";
    seedPersistentSession(sessionKey, "persistent-session");

    let agentExecutionStarted = false;
    runEmbeddedAgentMock.mockImplementationOnce(
      async (runParams: { onExecutionStarted?: () => void }) => {
        runParams.onExecutionStarted?.();
        agentExecutionStarted = true;
        return {
          payloads: [{ text: "completed" }],
          meta: { agentMeta: {} },
        };
      },
    );

    const writeRow = patchSessionEntryMock.getMockImplementation();
    if (!writeRow) {
      throw new Error("Expected guarded session writer");
    }
    patchSessionEntryMock.mockImplementation((scope, update, options) =>
      writeRow(
        scope,
        (entry: SessionEntry, context: { existingEntry?: SessionEntry }) =>
          update(entry, {
            existingEntry:
              agentExecutionStarted && scope.sessionKey === sessionKey
                ? { ...entry, lifecycleRevision: "replacement-revision" }
                : context.existingEntry,
          }),
        options,
      ),
    );

    await expect(
      runCronIsolatedAgentTurn(makePersistentCronParams(sessionKey)),
    ).resolves.toMatchObject({
      status: "error",
      error: `Session "${sessionKey}" changed while starting work. Retry.`,
      executionStarted: true,
    });
  });
});

describe("runCronIsolatedAgentTurn terminal lifecycle", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  it.each([
    ["failure", "error", undefined],
    ["cancelled", "aborted", undefined],
    ["cli-success", "final", undefined],
    ["cli-timeout", "error", undefined],
    ["cli-exhausted-result", "error", undefined],
    ["finalize-failure", "final", "delivery finalization failed"],
    ["continuation-failure", "final", "continuation write failed"],
    ["post-execution-abort", "final", "post-execution abort"],
    ["retry-preflight-failure", "error", "retry preparation failed"],
  ] as const)(
    "keeps a cron fallback active until outer $0 settlement",
    async (outcome, state, error) => {
      const sessionKey = "agent:main:cron:lifecycle-fallback";
      const sessionId = "cron-lifecycle-fallback";
      const usesContinuation =
        outcome === "continuation-failure" || outcome === "post-execution-abort";
      const initialSessionEntry = makeCronSessionEntry({ sessionId });
      resolveCronSessionMock.mockReturnValue(
        makeCronSession({
          store: { [sessionKey]: { ...initialSessionEntry } },
          initialSessionEntry,
          isNewSession: usesContinuation,
          sessionEntry: { ...initialSessionEntry },
        }),
      );
      loadSessionEntryMock.mockImplementation((_storePath, key) =>
        key === sessionKey ? { ...initialSessionEntry } : undefined,
      );
      resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-5.6-luna" });
      resolveAllowedModelRefMock.mockReturnValue({
        ref: { provider: "openai", model: "gpt-5.6-luna" },
      });
      const exhausted = outcome.includes("exhausted");
      const cliFallback = outcome.startsWith("cli-");
      const cancelled = outcome === "cancelled";
      resolveAgentModelFallbacksOverrideMock.mockReturnValue([
        cliFallback ? "claude-cli/fallback-model" : "openai/fallback-model",
      ]);
      if (cliFallback) {
        isCliProviderMock.mockImplementation((provider: string) => provider === "claude-cli");
      }
      const retryPreparationFailure = outcome === "retry-preflight-failure";
      const retryPreparationError = new AgentHarnessPreflightError("retry preparation failed");
      const retriesInterimAck = retryPreparationFailure;
      if (retriesInterimAck) {
        resolveCronPayloadOutcomeMock.mockImplementation(
          (await vi.importActual<typeof import("./helpers.js")>("./helpers.js"))
            .resolveCronPayloadOutcome,
        );
      }
      if (outcome === "finalize-failure") {
        dispatchCronDeliveryMock.mockRejectedValueOnce(new Error("delivery finalization failed"));
      }
      runWithModelFallbackMock.mockImplementation(
        (
          await vi.importActual<typeof import("../../agents/model-fallback-runner.js")>(
            "../../agents/model-fallback-runner.js",
          )
        ).runWithModelFallback,
      );
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const secondPreparing = createDeferred();
      const releaseSecond = createDeferred();
      const postExecutionWriteStarted = createDeferred();
      const releasePostExecutionWrite = createDeferred();
      const controller = new AbortController();
      const onExecutionStarted = vi.fn();
      let completedContinuationSessionKey: string | undefined;
      if (usesContinuation) {
        const patchSessionEntry = patchSessionEntryMock.getMockImplementation();
        if (!patchSessionEntry) {
          throw new Error("expected guarded cron writer");
        }
        patchSessionEntryMock.mockImplementation(
          async (
            ...args: Parameters<
              typeof import("../../config/sessions/session-accessor.js").patchSessionEntryCore
            >
          ) => {
            if (args[0].sessionKey === completedContinuationSessionKey) {
              completedContinuationSessionKey = undefined;
              if (outcome === "continuation-failure") {
                throw new Error("continuation write failed");
              }
              postExecutionWriteStarted.resolve();
              await releasePostExecutionWrite.promise;
            }
            return patchSessionEntry(...args);
          },
        );
      }
      const chatRunState = createChatRunState();
      const broadcast = vi.fn();
      const clearTrackedActiveRun = vi.fn();
      const persist = vi.fn<
        NonNullable<AgentEventHandlerOptions["persistGatewaySessionLifecycleEventForEvent"]>
      >(async () => {});
      const handler = createAgentEventHandler({
        broadcast,
        broadcastToConnIds: vi.fn(),
        nodeHasSessionSubscribers: () => false,
        nodeSendToSession: vi.fn(),
        agentRunSeq: new Map(),
        chatRunState,
        clearAgentRunContext,
        resolveSessionKeyForRun: () => sessionKey,
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        persistGatewaySessionLifecycleEventForEvent: persist,
        clearTrackedActiveRun,
      });
      const unsubscribe = onAgentRuntimeEvent(handler);
      const runIds = new Set<string>();
      let attemptIndex = 0;
      runCliAgentMock.mockImplementation(async (runParams: RunCliAgentParams) => {
        runIds.add(runParams.runId);
        attemptIndex++;
        await runParams.onExecutionStarted?.();
        secondPreparing.resolve();
        await releaseSecond.promise;
        if (outcome === "cli-exhausted-result") {
          // The real classifier rejects generic CLI failure copy; exhaustion
          // merges this candidate's metadata with the native incomplete reply.
          return {
            payloads: [{ text: GENERIC_EXTERNAL_RUN_FAILURE_TEXT }],
            meta: { agentMeta: {} },
          };
        }
        if (cancelled || outcome === "cli-timeout") {
          return {
            payloads: [],
            meta: {
              agentMeta: {},
              aborted: true,
              providerStarted: true,
              stopReason: cancelled ? "aborted" : "timeout",
              ...(outcome === "cli-timeout" ? { timeoutPhase: "provider" } : {}),
            },
          };
        }
        return { payloads: [{ text: "Final report" }], meta: { agentMeta: {} } };
      });
      runEmbeddedAgentMock.mockImplementation(async (runParams: RunEmbeddedAgentParams) => {
        runIds.add(runParams.runId);
        const first = attemptIndex++ === 0;
        if (retriesInterimAck && attemptIndex > 2) {
          throw retryPreparationError;
        }
        if (!first) {
          secondPreparing.resolve();
          await releaseSecond.promise;
        }
        const { provider, model, thinkLevel } = runParams;
        if (!provider || !model || !thinkLevel) {
          throw new Error("Cron did not prepare the model attempt");
        }
        const admittedRunContext = await resolvePreparedRunAdmission({
          ...runParams,
          runtimeKind: "embedded",
        });
        await runParams.onExecutionStarted?.();
        const authStorage = AuthStorage.inMemory();
        const native = createStubSessionHarness();
        const stream = prepareEmbeddedAttemptStream({
          attempt: {
            runId: runParams.runId,
            sessionId: runParams.sessionId,
            sessionKey: runParams.sessionKey,
            agentId: runParams.agentId,
            workspaceDir: runParams.workspaceDir,
            prompt: runParams.prompt,
            timeoutMs: runParams.timeoutMs,
            config: runParams.config,
            trigger: runParams.trigger,
            abortSignal: runParams.abortSignal,
            deferTerminalLifecycle: runParams.deferTerminalLifecycle,
            onAgentEvent: runParams.onAgentEvent,
            admittedRunContext,
            provider,
            modelId: model,
            model: makeProviderModelFixture({
              provider,
              id: model,
              api: "openai-responses",
              baseUrl: "https://provider.test",
            }),
            thinkLevel,
            sessionFile: sessionKey,
            authStorage,
            authProfileStore: { version: 1, profiles: {} },
            modelRegistry: ModelRegistry.inMemory(authStorage),
            startedAtMs: Date.now(),
          },
          agentSession: {
            activeSession: native.session,
            hookRunner: getGlobalHookRunner(),
            clientToolCallSlots: [],
            hasDeliveredSourceReply: () => false,
            markSourceReplyDelivered: vi.fn(),
            builtinToolNames: new Set(),
            coreBuiltinToolNames: new Set(),
            replaySafeToolNames: new Set(),
            codeModeExecToolNames: new Set(),
            sideEffectToolOwners: new Map(),
            trustedLocalMediaToolNames: new Set(),
          },
          hookAgentId: "main",
          diagnosticTrace: { traceId: "1".repeat(32) },
          diagnosticOwner: createDiagnosticEmbeddedRunOwner({
            sessionId,
            sessionKey,
            runId: runParams.runId,
          }),
          nestedToolActivities: [],
          isReplaySafeTool: () => false,
          runAbortController: new AbortController(),
          abortRun: vi.fn(),
          markExternalAbort: vi.fn(),
          getRunState: () => ({
            aborted: controller.signal.aborted,
            promptError: undefined,
            timedOut: false,
            yieldDetected: false,
          }),
          onBlockReply: undefined,
          onBlockReplyFlush: undefined,
        });
        const emitAssistantEnd = (overrides: Parameters<typeof makeAssistantMessageFixture>[0]) => {
          const message = makeAssistantMessageFixture({
            provider,
            model,
            errorMessage: undefined,
            ...overrides,
          });
          native.emit({ type: "message_start", message });
          native.emit({ type: "message_end", message });
          native.emit({ type: "agent_end", messages: [message], willRetry: false });
        };
        try {
          native.emit({ type: "agent_start" });
          if (first || outcome === "failure") {
            if (first) {
              firstStarted.resolve();
              await releaseFirst.promise;
            }
            const incomplete = outcome === "cli-exhausted-result";
            emitAssistantEnd({
              stopReason: incomplete ? "stop" : "error",
              errorMessage: incomplete ? undefined : "429 rate limit",
              content: incomplete ? [{ type: "thinking", thinking: "Still reasoning" }] : [],
            });
            if (incomplete) {
              // Native terminal resolution preserves a safe incomplete reply after
              // its internal retries; the later CLI candidate supplies no liveness.
              return {
                payloads: [{ text: "Incomplete provider response", isError: true }],
                meta: {
                  agentMeta: {},
                  livenessState: "abandoned",
                  replayInvalid: true,
                  error: {
                    kind: "incomplete_turn",
                    message: "Incomplete provider response",
                    fallbackSafe: true,
                  },
                },
              };
            }
            throw new FailoverError("429 rate limit", { reason: "rate_limit", provider, model });
          }
          if (outcome === "cancelled") {
            emitAssistantEnd({ stopReason: "aborted", content: [] });
            return { payloads: [], meta: { aborted: true, stopReason: "aborted", agentMeta: {} } };
          }
          const text = retriesInterimAck ? "On it." : "Final report";
          emitAssistantEnd({
            stopReason: "stop",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
          });
          if (usesContinuation) {
            expect(runParams.sessionKey).toContain(":run:");
            completedContinuationSessionKey = runParams.sessionKey;
          }
          return {
            payloads: [{ text }],
            meta: { agentMeta: {}, stopReason: "stop" },
          };
        } finally {
          stream.subscription.unsubscribe();
          clearActiveEmbeddedRun(sessionId, stream.queueHandle, sessionKey);
        }
      });
      const run = runCronIsolatedAgentTurn({
        ...makeIsolatedAgentParamsFixture({
          agentId: "main",
          sessionKey,
          job: makeIsolatedAgentJobFixture({
            sessionTarget: usesContinuation ? "isolated" : `session:${sessionKey}`,
            delivery: { mode: "none" },
          }),
        }),
        abortSignal: controller.signal,
        onExecutionStarted,
      });
      const exited = run.then((result) => {
        throw new Error(`Cron exited before fallback boundary: ${JSON.stringify(result)}`);
      });
      try {
        await Promise.race([firstStarted.promise, exited]);
        vi.useFakeTimers();
        releaseFirst.resolve();
        await Promise.race([secondPreparing.promise, exited]);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(attemptIndex).toBe(2);
        expect(runCliAgentMock).toHaveBeenCalledTimes(cliFallback ? 1 : 0);
        expect(broadcast.mock.calls.filter(([event]) => event === "chat")).toHaveLength(0);
        expect(
          persist.mock.calls.filter(([params]) => params.event.data?.phase === "error"),
        ).toHaveLength(0);
        const [runId] = runIds;
        assert(runId);
        expect(runId).not.toBe(sessionId);
        expect(runIds.size).toBe(1);
        expect(getAgentRunContextOwnership(runId)?.clearRequested).toBe(false);
        expect(clearTrackedActiveRun).not.toHaveBeenCalled();
        if (cancelled) {
          controller.abort();
        }
        releaseSecond.resolve();
        if (outcome === "post-execution-abort") {
          await Promise.race([postExecutionWriteStarted.promise, exited]);
          controller.abort(new Error("post-execution abort"));
          releasePostExecutionWrite.resolve();
        }
        const succeeded = outcome === "cli-success";
        await expect(run).resolves.toMatchObject({ status: succeeded ? "ok" : "error" });
        if (error) {
          await expect(run).resolves.toMatchObject({
            error: retryPreparationFailure ? expect.stringContaining(error) : error,
          });
        }
        if (outcome === "finalize-failure") {
          await expect(run).resolves.toMatchObject({ executionStarted: true });
        }
        if (retryPreparationFailure) {
          await expect(runWithModelFallbackMock.mock.results[1]?.value).rejects.toBe(
            retryPreparationError,
          );
        }
        // Final failures settle without advancing retry grace, including preflight
        // failures that never emitted a candidate lifecycle or fallback step.
        if (exhausted || retryPreparationFailure) {
          if (outcome === "cli-exhausted-result") {
            await expect(runWithModelFallbackMock.mock.results[0]?.value).resolves.toMatchObject({
              outcome: "exhausted",
              result: { result: { meta: { error: { kind: "incomplete_turn" } } } },
            });
          }
          expect({
            terminalWrites: persist.mock.calls.filter(
              ([params]) => params.event.data?.phase === "error",
            ).length,
            activityClears: clearTrackedActiveRun.mock.calls.length,
          }).toEqual({ terminalWrites: 1, activityClears: 1 });
          expect(clearTrackedActiveRun).toHaveBeenCalledExactlyOnceWith({
            runId,
            clientRunId: runId,
            sessionKey,
          });
        }
        expect(onExecutionStarted).toHaveBeenCalledTimes(2);
        expect(runIds.size).toBe(1);
        expect(
          broadcast.mock.calls.filter(
            ([event, payload]) => event === "chat" && payload.state !== "delta",
          ),
        ).toEqual([
          [
            "chat",
            expect.objectContaining({
              runId,
              state,
              ...(outcome === "cli-timeout" ? { stopReason: "timeout", errorKind: "timeout" } : {}),
            }),
            expect.anything(),
          ],
        ]);
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        releasePostExecutionWrite.resolve();
        await run.catch(() => {});
        unsubscribe();
        handler.dispose();
        vi.useRealTimers();
      }
    },
  );
});
