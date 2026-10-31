import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { releaseSessionControllerClaim } from "../../sessions/session-controller.mailbox.js";
import { isSessionRunActive } from "../../sessions/session-controller.queries.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  createDirectRuntimeReplyParams,
  directSessionKey,
} from "./agent-runner-direct-runtime-config.test-fixtures.js";
import type { AgentTurnParams, EmbeddedAgentRunResult } from "./agent-runner-execution.types.js";
import * as agentRunnerResult from "./agent-runner-result.js";
import { withTestModelContextTokens } from "./agent-runner.test-fixtures.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import { resolveReplyOperationAgentTurn } from "./reply-operation-run-state.test-support.js";

const freshCfg = { runtimeFresh: true };
const sentinelError = new Error("stop-after-preflight");

const {
  resolveQueuedReplyExecutionConfigMock,
  runSessionCompactionIfNeededMock,
  runMemoryFlushIfNeededMock,
  executeAgentTurnMock,
  enqueueFollowupRunMock,
  compactEmbeddedAgentSessionMock,
  runEmbeddedAgentMock,
} = vi.hoisted(() => ({
  resolveQueuedReplyExecutionConfigMock: vi.fn(),
  runSessionCompactionIfNeededMock: vi.fn(),
  runMemoryFlushIfNeededMock: vi.fn(),
  executeAgentTurnMock: vi.fn(),
  enqueueFollowupRunMock: vi.fn(),
  compactEmbeddedAgentSessionMock: vi.fn(),
  runEmbeddedAgentMock: vi.fn(),
}));

// mock-isolation: keep provider execution fixture-controlled while exercising real reply admission.
vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: resolveQueuedReplyExecutionConfigMock,
}));

// mock-isolation: drive preflight checkpoints without running compaction or memory flushes.
vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: runSessionCompactionIfNeededMock,
  runMemoryFlushIfNeeded: runMemoryFlushIfNeededMock,
}));

vi.mock("./agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-execution.js")>()),
  executeAgentTurn: executeAgentTurnMock,
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: enqueueFollowupRunMock,
}));

const { runReplyAgent } = await import("./agent-runner-run.js");

type PreflightParams = Parameters<
  typeof import("./agent-runner-memory.js").runSessionCompactionIfNeeded
>[0];

async function runRequiredCheckpoint(params: PreflightParams) {
  if (!params.beforeCompaction) {
    throw new Error("Expected the required preflight checkpoint");
  }
  return params.beforeCompaction(
    params.sessionEntry ?? { sessionId: params.followupRun.run.sessionId, updatedAt: 1 },
  );
}

async function createStoredRuntime(tempDir: string, overrides: Partial<SessionEntry> = {}) {
  const runtime = createDirectRuntimeReplyParams();
  const { replyParams, followupRun } = runtime;
  const sessionKey = directSessionKey;
  const sessionEntry: SessionEntry = { sessionId: "session-1", updatedAt: 1, ...overrides };
  const storePath = join(tempDir, "sessions.json");
  const scope = { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath };
  await replaceSessionEntry(scope, sessionEntry);
  Object.assign(replyParams, {
    sessionKey,
    storePath,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
  });
  followupRun.run.config = { ...followupRun.run.config, session: { store: storePath } };
  return { ...runtime, sessionKey, sessionEntry, storePath, scope };
}

async function useRealMemory({ flush = true } = {}) {
  const memory = await vi.importActual<typeof import("./agent-runner-memory.js")>(
    "./agent-runner-memory.js",
  );
  runSessionCompactionIfNeededMock.mockImplementation(memory.runSessionCompactionIfNeeded);
  if (flush) {
    runMemoryFlushIfNeededMock.mockImplementation(memory.runMemoryFlushIfNeeded);
  }
}

function resolveMemoryConfig(runtime: Awaited<ReturnType<typeof createStoredRuntime>>, cfg = {}) {
  const { followupRun, replyParams, storePath } = runtime;
  Object.assign(followupRun.run, { provider: "anthropic", model: "claude-sonnet-4-6" });
  const resolved = withTestModelContextTokens({
    cfg: { session: { store: storePath }, ...cfg },
    followupRun,
    defaultModel: replyParams.defaultModel,
    contextTokens: 100_000,
  });
  resolveQueuedReplyExecutionConfigMock.mockResolvedValue(resolved);
  return resolved;
}

function settledTurn(
  runId: string,
  result: EmbeddedAgentRunResult = { payloads: [], meta: { durationMs: 0 } },
) {
  return {
    runId,
    outcome: {
      kind: "settled",
      status: "ok",
      result,
      resolved: { provider: "openai", model: "gpt-5.4" },
      fallback: { exhausted: false, attempts: [] },
      autoCompactionCount: 0,
      didLogHeartbeatStrip: false,
    },
  };
}

describe("runReplyAgent runtime config", () => {
  beforeEach(() => {
    resolveQueuedReplyExecutionConfigMock.mockReset();
    runSessionCompactionIfNeededMock.mockReset();
    runMemoryFlushIfNeededMock.mockReset();
    executeAgentTurnMock.mockReset();
    enqueueFollowupRunMock.mockReset();
    compactEmbeddedAgentSessionMock.mockReset().mockResolvedValue({
      ok: true,
      compacted: true,
      result: { tokensAfter: 42 },
    });
    runEmbeddedAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });

    resolveQueuedReplyExecutionConfigMock.mockResolvedValue(freshCfg);
    runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry: undefined, outcome: "skipped" });
    executeAgentTurnMock.mockResolvedValue({
      runId: "runtime-config-test",
      outcome: { kind: "rejected", payload: { text: "main reply" } },
    });
  });

  it.each(["completed", "failed"] as const)(
    "reports one %s terminal outcome after finalization settles",
    async (outcome) => {
      const { replyParams } = createDirectRuntimeReplyParams();
      const onAgentRunTerminalOutcome = vi.fn();
      replyParams.opts = { onAgentRunTerminalOutcome };
      runSessionCompactionIfNeededMock.mockImplementation(runRequiredCheckpoint);
      executeAgentTurnMock.mockImplementationOnce(async (params: AgentTurnParams) => {
        params.opts?.onAgentRunTerminalOutcome?.("completed");
        return settledTurn("runtime-config-test");
      });
      const finalize = vi
        .spyOn(agentRunnerResult, "finalizeReplyAgentRun")
        .mockImplementationOnce(async () => {
          expect(onAgentRunTerminalOutcome).not.toHaveBeenCalled();
          if (outcome === "failed") {
            throw sentinelError;
          }
          return { text: "done" };
        });
      try {
        if (outcome === "failed") {
          await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);
        } else {
          await expect(runReplyAgent(replyParams)).resolves.toEqual({ text: "done" });
        }
        expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith(outcome);
      } finally {
        finalize.mockRestore();
      }
    },
  );

  it("reports a queued recovery failure after the parent terminal outcome", async () => {
    await withTestDir({ prefix: "openclaw-terminal-recovery-" }, async (tempDir) => {
      const { replyParams, followupRun, sessionEntry, storePath } = await createStoredRuntime(
        tempDir,
        {
          lifecycleRevision: "terminal-recovery",
        },
      );
      const onAgentRunTerminalOutcome = vi.fn();
      followupRun.run.workspaceDir = tempDir;
      followupRun.runObservers = { onAgentRunTerminalOutcome };
      replyParams.opts = {
        sourceReplyDeliveryMode: "message_tool_only",
        onAgentRunTerminalOutcome,
        onBlockReply: vi.fn(async () => {}),
      };
      resolveQueuedReplyExecutionConfigMock.mockResolvedValue({
        ...freshCfg,
        session: { store: storePath },
        messages: { visibleReplies: "message_tool" },
      });
      runSessionCompactionIfNeededMock.mockImplementation(runRequiredCheckpoint);
      enqueueFollowupRunMock.mockReturnValue(true);
      const finalText = "This is the substantive reply that still needs to reach the user. ".repeat(
        8,
      );
      executeAgentTurnMock
        .mockImplementationOnce(async (params: AgentTurnParams) => {
          params.opts?.onAgentRunTerminalOutcome?.("completed");
          return settledTurn("parent-turn", {
            payloads: [{ text: finalText }],
            meta: {
              durationMs: 0,
              finalAssistantVisibleText: finalText,
              terminalReply: { disposition: "visible", text: finalText },
            },
          });
        })
        .mockImplementationOnce(async (params: AgentTurnParams) => {
          params.opts?.onAgentRunTerminalOutcome?.("failed");
          return {
            runId: "recovery-turn",
            outcome: { kind: "rejected", payload: { text: "Recovery failed", isError: true } },
          };
        });

      await runReplyAgent(replyParams);
      expect(onAgentRunTerminalOutcome.mock.calls).toEqual([["completed"]]);
      expect(isSessionRunActive(sessionEntry.sessionId)).toBe(false);
      expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
      const queuedCall = enqueueFollowupRunMock.mock.calls[0] as
        | Parameters<typeof import("./queue.js").enqueueFollowupRun>
        | undefined;
      if (!queuedCall?.[4]) {
        throw new Error("Expected the queued recovery runner");
      }
      expect(queuedCall[1].strandedReplyRetry).toBe(true);
      try {
        await queuedCall[4](queuedCall[1]);

        expect(queuedCall[1].controllerInput?.claim).toBeDefined();
        expect(onAgentRunTerminalOutcome.mock.calls).toEqual([["completed"], ["failed"]]);
        expect(isSessionRunActive(sessionEntry.sessionId)).toBe(false);
      } finally {
        // This direct invocation also owns the claim cleanup normally performed by the queue drain.
        const claim = queuedCall[1].controllerInput?.claim;
        if (claim) {
          releaseSessionControllerClaim(claim);
          await claim.settlement.promise;
        }
      }
    });
  });

  it.each(["failure", "operation abort", "memory flush"] as const)(
    "keeps preflight live and stops its heartbeat after %s",
    async (outcome) => {
      const flushing = outcome === "memory flush";
      await useRealMemory({ flush: flushing });
      if (flushing) {
        registerMemoryCapability("memory-core", {
          flushPlanResolver: () => ({
            softThresholdTokens: 4_000,
            forceFlushTranscriptBytes: 1_000_000_000,
            reserveTokensFloor: 20_000,
            prompt: "Save durable notes. NO_REPLY",
            systemPrompt: "Write memory to memory/notes.md.",
            relativePath: "memory/notes.md",
          }),
        });
        onTestFinished(() => clearMemoryPluginState());
      }
      await withTestDir({ prefix: "openclaw-preflight-heartbeat-" }, async (tempDir) => {
        const runtime = await createStoredRuntime(tempDir, {
          totalTokens: 95_000,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        });
        const { replyParams, followupRun, sessionEntry } = runtime;
        if (flushing) {
          followupRun.run.workspaceDir = tempDir;
        }
        const cfg = resolveMemoryConfig(
          runtime,
          flushing ? { agents: { defaults: { compaction: { memoryFlush: {} } } } } : {},
        );
        if (flushing) {
          setRuntimeConfigSnapshot(cfg);
          onTestFinished(() => clearRuntimeConfigSnapshot());
        }
        const onReplyOperationOwned = vi.fn<(operation: ReplyOperation) => void>();
        const lifecycle = {
          admission: "exclusive" as const,
          abortSignal: new AbortController().signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onDeferredHeartbeat: vi.fn(),
          deferredHeartbeatIntervalMs: 100,
          onAbandoned: vi.fn(),
        };
        followupRun.turnAdoptionLifecycle = lifecycle;
        replyParams.opts = { turnAdoptionLifecycle: lifecycle, onReplyOperationOwned };
        const entered = createDeferred();
        const release = createDeferred();
        const waitForRelease = async () => {
          entered.resolve();
          await release.promise;
        };
        if (flushing) {
          runEmbeddedAgentMock.mockImplementationOnce(async () => {
            await waitForRelease();
            return { payloads: [], meta: {} };
          });
        } else {
          runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry, outcome: "skipped" });
          compactEmbeddedAgentSessionMock.mockReset().mockImplementation(async () => {
            await waitForRelease();
            if (outcome === "failure") {
              throw new Error("Preflight compaction required but failed: test failure");
            }
            return { ok: true, compacted: true, result: { tokensAfter: 42 } };
          });
        }
        vi.useFakeTimers();
        const pending = runReplyAgent(replyParams);
        try {
          await expect(
            Promise.race([
              entered.promise.then(() => "entered"),
              pending.then(() => "completed-before-preflight"),
            ]),
          ).resolves.toBe("entered");
          await vi.advanceTimersByTimeAsync(350);
          if (!flushing) {
            expect(lifecycle.onAdopted).not.toHaveBeenCalled();
          }
          expect(lifecycle.onDeferredHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
          if (outcome === "operation abort") {
            expect(onReplyOperationOwned.mock.calls[0]?.[0].abortByUser()).toBe(true);
            lifecycle.onDeferredHeartbeat.mockClear();
            await vi.advanceTimersByTimeAsync(500);
            expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
          }
          release.resolve();
          if (flushing) {
            await expect(pending).resolves.toEqual({ text: "main reply" });
            expect(lifecycle.onAdopted).toHaveBeenCalledOnce();
          } else {
            await pending;
          }
          lifecycle.onDeferredHeartbeat.mockClear();
          await vi.advanceTimersByTimeAsync(500);
          expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await Promise.allSettled([pending]);
          vi.useRealTimers();
        }
      });
    },
  );

  it("records abortForRestart during memory flush as cancellation without starting the main turn", async () => {
    const { replyParams } = createDirectRuntimeReplyParams();
    const runState: ReplyOperationRunState = {};
    replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
    runSessionCompactionIfNeededMock.mockImplementation(runRequiredCheckpoint);
    runMemoryFlushIfNeededMock.mockImplementation(
      async (params: { replyOperation: ReplyOperation }) => {
        expect(params.replyOperation.abortForRestart()).toBe(true);
        return { sessionEntry: undefined, outcome: "failed" };
      },
    );

    const result = await runReplyAgent(replyParams);

    expect(result).toEqual({});
    expect(resolveReplyOperationAgentTurn(runState)).toBe("cancelled");
    expect(executeAgentTurnMock).not.toHaveBeenCalled();
  });

  it("records an aborted user agent turn as cancellation", async () => {
    const { replyParams } = createDirectRuntimeReplyParams();
    const runState: ReplyOperationRunState = {};
    replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
    runSessionCompactionIfNeededMock.mockResolvedValue(undefined);
    executeAgentTurnMock.mockResolvedValue({
      runId: "cancelled-runtime-config-test",
      outcome: { kind: "aborted", reason: "user" },
    });

    await runReplyAgent(replyParams);

    expect(resolveReplyOperationAgentTurn(runState)).toBe("cancelled");
  });

  it("delivers known pre-run OAuth refresh failures instead of dropping the reply", async () => {
    const { replyParams } = createDirectRuntimeReplyParams();
    runSessionCompactionIfNeededMock.mockRejectedValue(
      new OAuthRefreshFailureError({
        provider: "openai",
        message: "refresh_token_invalidated",
      }),
    );
    const delivered = vi.fn<(payload: ReplyPayload, kind: ReplyDispatchKind) => void>();
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, { kind }) => {
        delivered(payload, kind);
      },
    });

    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => {
        const payload = await runReplyAgent(replyParams);
        if (!payload || Array.isArray(payload)) {
          throw new Error("expected a single pre-run failure reply payload");
        }
        dispatcher.sendFinalReply(payload);
        return payload;
      },
    });

    expect(getReplyPayloadMetadata(result)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(executeAgentTurnMock).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: expect.stringContaining("/login openai"), isError: true }),
      "final",
    );
    expect(delivered.mock.calls[0]?.[0].presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Sign in",
              action: { type: "command", command: "/login openai" },
            },
          ],
        },
      ],
    });
  });

  it.each([
    { source: "current prepared", revokeDuring: undefined, kept: true },
    { source: "revoked during preflight", revokeDuring: "preflight", kept: false },
    { source: "revoked while resolving input", revokeDuring: "persist", kept: false },
    { source: "revoked original input", revokeDuring: "source", kept: false },
    { source: "original input revoked by its hook", revokeDuring: "hook", kept: false },
  ] as const)(
    "keeps input through preparation only for a $source source",
    async ({ revokeDuring, kept }) => {
      await withTestDir({ prefix: "openclaw-preflight-user-turn-" }, async (tempDir) => {
        const { replyParams, followupRun, sessionEntry, storePath, scope } =
          await createStoredRuntime(tempDir);
        await appendTranscriptMessage(scope, { message: { role: "user", content: "earlier" } });
        let revoked = false;
        let sourceRevoked = revokeDuring === "source";
        const input = {
          text: "the turn that hit the failed preflight",
          idempotencyKey: "source-1",
        };
        const assertOriginalSource = () => {
          if (sourceRevoked) {
            throw new Error("original input source revoked");
          }
        };
        const preparedSource = Object.assign(
          () => {
            throw new Error("Original input source was not prepared");
          },
          {
            prepareSessionSourceScope: async () => {
              // Source preparation can read the receiving store without deadlocking its writer.
              await listSessionPendingInputs(scope);
              return { assertCurrent: assertOriginalSource, checks: [] };
            },
          },
        );
        followupRun.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
          input,
          assertOriginalInputCommit:
            revokeDuring === undefined || revokeDuring === "hook"
              ? preparedSource
              : assertOriginalSource,
          // Input resolution precedes durable custody and required maintenance.
          resolveInput: async () => {
            revoked ||= revokeDuring === "persist";
            return input;
          },
          beforeMessageWrite: ({ message }) => {
            sourceRevoked ||= revokeDuring === "hook";
            return message;
          },
          target: { ...scope, sessionEntry, cwd: tempDir, config: {} },
        });
        followupRun.operatorAuthority = createAdmittedRunOperatorAuthority({
          profileId: "linked-admin",
          scopes: ["operator.admin"],
          gatewayAccessGrant: null,
          source: {},
          assertCurrent: () => {
            if (revoked) {
              throw new Error("operator access revoked");
            }
          },
        });
        resolveQueuedReplyExecutionConfigMock.mockResolvedValue({
          ...freshCfg,
          session: { store: storePath },
        });
        runSessionCompactionIfNeededMock.mockImplementation(async () => {
          revoked = revokeDuring === "preflight";
          throw new Error("Preflight compaction required but failed: summarization_failed");
        });

        const reply = runReplyAgent(replyParams);
        if (revokeDuring === "persist" || revokeDuring === "source" || revokeDuring === "hook") {
          await expect(reply).rejects.toThrow(
            revokeDuring === "persist"
              ? "operator access revoked"
              : "original input source revoked",
          );
          expect(runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
          expect((await listSessionPendingInputs(scope)).total).toBe(0);
        } else {
          await expect(reply).resolves.toMatchObject({
            text: expect.stringContaining("couldn't shorten it"),
          });
        }
        expect(executeAgentTurnMock).not.toHaveBeenCalled();
        const failedTurn = expect.objectContaining({
          role: "user",
          content: "the turn that hit the failed preflight",
          idempotencyKey: "source-1",
        });
        expect((await SessionManager.openAsync(scope)).buildSessionContext().messages).toEqual([
          expect.objectContaining({ role: "user", content: "earlier" }),
          ...(kept ? [failedTurn] : []),
        ]);
      });
    },
  );

  it("does not resolve secrets before the enqueue-followup queue path", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: true,
      isActive: true,
      queueMode: "followup",
    });
    const runState: ReplyOperationRunState = {};
    replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
    enqueueFollowupRunMock.mockReturnValueOnce(true);

    await expect(runReplyAgent(replyParams)).resolves.toBeUndefined();

    expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
    expect(resolveQueuedReplyExecutionConfigMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalledOnce();
  });
});
