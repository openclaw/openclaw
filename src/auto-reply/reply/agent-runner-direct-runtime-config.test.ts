// Tests direct runtime config overrides passed into agent runner execution.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { FailoverError } from "../../agents/failover-error.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";
import type { QueueSettings } from "./queue.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { createMockReplyOperation, createMockTypingController } from "./test-helpers.js";

const freshCfg = { runtimeFresh: true };
const staleCfg = {
  runtimeFresh: false,
  skills: {
    entries: {
      whisper: { apiKey: { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" } },
    },
  },
};
const sentinelError = new Error("stop-after-preflight");

const resolveQueuedReplyExecutionConfigMock = vi.fn();
const resolveReplyToModeMock = vi.fn();
const runSessionCompactionIfNeededMock = vi.fn();
const runMemoryFlushIfNeededMock = vi.fn();
const executeAgentTurnMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const compactEmbeddedAgentSessionMock = vi.fn();
const runEmbeddedAgentMock = vi.fn();

vi.mock("../../agents/embedded-agent.js", () => ({
  compactEmbeddedAgentSession: (...args: unknown[]) => compactEmbeddedAgentSessionMock(...args),
  runEmbeddedAgent: (...args: unknown[]) => runEmbeddedAgentMock(...args),
}));

vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: (...args: unknown[]) =>
    resolveQueuedReplyExecutionConfigMock(...args),
}));

vi.mock("./reply-threading.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-threading.js")>()),
  resolveReplyToMode: (...args: unknown[]) => resolveReplyToModeMock(...args),
  createReplyToModeFilterForChannel: () => (payload: unknown) => payload,
}));

vi.mock("./reply-media-paths.js", () => ({
  createReplyMediaContext: () => ({ normalizePayload: (payload: unknown) => payload }),
  createReplyMediaPathNormalizer: () => (payload: unknown) => payload,
}));

vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: (...args: unknown[]) => runSessionCompactionIfNeededMock(...args),
  runMemoryFlushIfNeeded: (...args: unknown[]) => runMemoryFlushIfNeededMock(...args),
}));

vi.mock("./agent-runner-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-execution.js")>()),
  executeAgentTurn: (...args: unknown[]) => executeAgentTurnMock(...args),
}));

vi.mock("./queue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./queue.js")>()),
  enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
}));

const { runReplyAgent } = await import("./agent-runner-run.js");

type ReplyParams = Parameters<typeof runReplyAgent>[0];

function createDirectRuntimeReplyParams(
  overrides: Partial<Pick<ReplyParams, "shouldFollowup" | "isActive">> = {},
) {
  const followupRun = createTestFollowupRun({
    sessionId: "session-1",
    sessionKey: "agent:main:telegram:default:direct:test",
    messageProvider: "telegram",
    config: staleCfg,
    provider: "openai",
    model: "gpt-5.4",
  });
  const resolvedQueue: QueueSettings = { mode: "interrupt" };
  const replyParams: ReplyParams = {
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      AccountId: "default",
      ChatType: "dm",
      MessageSid: "msg-1",
    },
    defaultModel: "openai/gpt-5.4",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    ...overrides,
  };

  return { followupRun, resolvedQueue, replyParams };
}

async function createStoredReply(tempDir: string, overrides: Partial<SessionEntry> = {}) {
  const params = createDirectRuntimeReplyParams();
  const sessionKey = "agent:main:telegram:default:direct:test";
  const sessionEntry: SessionEntry = { sessionId: "session-1", updatedAt: 1, ...overrides };
  const storePath = join(tempDir, "sessions.json");
  const scope = { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath };
  const sessionStore = { [sessionKey]: sessionEntry };
  await replaceSessionEntry(scope, sessionEntry);
  Object.assign(params.replyParams, { sessionKey, storePath, sessionEntry, sessionStore });
  return { ...params, sessionKey, sessionEntry, sessionStore, scope };
}

async function useRealMaintenance({ flush = true } = {}) {
  const memory = await vi.importActual<typeof import("./agent-runner-memory.js")>(
    "./agent-runner-memory.js",
  );
  runSessionCompactionIfNeededMock.mockImplementation(memory.runSessionCompactionIfNeeded);
  if (flush) {
    runMemoryFlushIfNeededMock.mockImplementation(memory.runMemoryFlushIfNeeded);
  }
}

function registerMemoryFlush(forceFlushTranscriptBytes: number) {
  onTestFinished(clearMemoryPluginState);
  registerMemoryCapability("memory-core", {
    flushPlanResolver: () => ({
      softThresholdTokens: 4_000,
      forceFlushTranscriptBytes,
      reserveTokensFloor: 20_000,
      prompt: "Save durable notes. NO_REPLY",
      systemPrompt: "Write memory to memory/notes.md.",
      relativePath: "memory/notes.md",
    }),
  });
}

function configureContext(
  { followupRun, replyParams }: ReturnType<typeof createDirectRuntimeReplyParams>,
  cfg: OpenClawConfig = {},
) {
  const config = withTestModelContextTokens({
    cfg,
    followupRun,
    defaultModel: replyParams.defaultModel,
    contextTokens: 100_000,
  });
  resolveQueuedReplyExecutionConfigMock.mockResolvedValue(config);
  return config;
}

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

describe("runReplyAgent runtime config", () => {
  beforeEach(() => {
    resolveQueuedReplyExecutionConfigMock.mockReset();
    resolveReplyToModeMock.mockReset();
    runSessionCompactionIfNeededMock.mockReset();
    runMemoryFlushIfNeededMock.mockReset();
    executeAgentTurnMock.mockReset();
    enqueueFollowupRunMock.mockReset();
    compactEmbeddedAgentSessionMock
      .mockReset()
      .mockResolvedValue({ ok: true, compacted: true, result: { tokensAfter: 42 } });
    runEmbeddedAgentMock.mockReset().mockResolvedValue({ payloads: [], meta: {} });

    resolveQueuedReplyExecutionConfigMock.mockResolvedValue(freshCfg);
    resolveReplyToModeMock.mockReturnValue("all");
    runSessionCompactionIfNeededMock.mockImplementation(async (params: PreflightParams) => {
      await runRequiredCheckpoint(params);
      throw sentinelError;
    });
    runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry: undefined, outcome: "skipped" });
    executeAgentTurnMock.mockResolvedValue({
      runId: "runtime-config-test",
      outcome: { kind: "rejected", payload: { text: "main reply" } },
    });
  });

  it("passes the derived runtime-policy key to pre-run maintenance", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams();
    const runtimePolicySessionKey = "agent:main:telegram:default:direct:test";
    followupRun.run.sessionKey = "agent:main:main";
    followupRun.run.runtimePolicySessionKey = runtimePolicySessionKey;
    replyParams.sessionKey = "agent:main:main";
    replyParams.runtimePolicySessionKey = runtimePolicySessionKey;

    await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);

    expect(followupRun.run.config).toBe(freshCfg);
    const [configArg, configContextArg] = resolveQueuedReplyExecutionConfigMock.mock.calls[0];
    expect(configArg).toBe(staleCfg);
    expect(configContextArg).toMatchObject({
      originatingChannel: "telegram",
      messageProvider: "telegram",
    });
    expect(resolveReplyToModeMock).toHaveBeenCalledWith(freshCfg, "telegram", "default", "dm");
    for (const mock of [runSessionCompactionIfNeededMock, runMemoryFlushIfNeededMock]) {
      expect(mock.mock.calls[0]?.[0]).toMatchObject({
        sessionKey: "agent:main:main",
        runtimePolicySessionKey,
      });
      expect(mock.mock.calls[0]?.[0].cfg).toBe(freshCfg);
    }
  });

  it("continues the main reply after a recorded memory-flush failure", async () => {
    const { replyParams } = createDirectRuntimeReplyParams();
    const onBlockReply = vi.fn();
    const { replyOperation } = createMockReplyOperation({ key: "test", sessionId: "session-1" });
    replyOperation.phase = "queued";
    replyOperation.captureOwnedSessionIds = vi.fn(() => new Set<string>());
    replyParams.opts = { sourceReplyDeliveryMode: "message_tool_only", onBlockReply };
    replyParams.replyOperation = replyOperation;
    resolveQueuedReplyExecutionConfigMock.mockResolvedValue({
      ...freshCfg,
      agents: { defaults: { compaction: { notifyUser: true } } },
    });
    runSessionCompactionIfNeededMock.mockImplementation(runRequiredCheckpoint);
    runMemoryFlushIfNeededMock.mockImplementation(
      async (params: { replyOperation: ReplyOperation }) => {
        params.replyOperation.setPhase("memory_flushing");
        return { sessionEntry: undefined, outcome: "failed" };
      },
    );

    const result = await runReplyAgent(replyParams);

    expect(result).toEqual({ text: "main reply" });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(executeAgentTurnMock).toHaveBeenCalledOnce();
    expect(replyOperation.setPhase).toHaveBeenLastCalledWith("running");
  });

  it("preserves conversation without running byte-forced optional memory work before reply", async () => {
    await useRealMaintenance();
    registerMemoryFlush(1);
    await withTestDir({ prefix: "openclaw-direct-runtime-" }, async (tempDir) => {
      const { replyParams, followupRun, sessionKey, sessionEntry, sessionStore, scope } =
        await createStoredReply(tempDir, {
          lifecycleRevision: "before-maintenance",
          totalTokens: 100,
          totalTokensFresh: true,
          totalTokensVersion: 1,
          compactionCount: 4,
          memoryFlush: { kind: "failed", failureCount: 2 },
        });
      const olderMessage = { role: "user", content: "Remember the older marker: amber-orchid" };
      const messages = [
        olderMessage,
        { role: "assistant", content: "Noted." },
        ...Array.from({ length: 3 }, (_, index) => [
          { role: "user", content: `Recent question ${index}` },
          { role: "assistant", content: `Recent answer ${index}` },
        ]).flat(),
      ];
      for (const message of messages) {
        await appendTranscriptMessage(scope, { message });
      }
      // A file blocks the memory directory: optional maintenance fails without token pressure.
      await writeFile(join(tempDir, "memory"), "not a directory");
      followupRun.run.workspaceDir = tempDir;
      followupRun.run.provider = "anthropic";
      followupRun.run.model = "claude-sonnet-4-6";
      configureContext(
        { followupRun, replyParams },
        {
          agents: { defaults: { compaction: { notifyUser: true } } },
        },
      );
      const onBlockReply = vi.fn();
      const onReplyOperationOwned = vi.fn<(operation: ReplyOperation) => void>();
      replyParams.opts = { onBlockReply, onReplyOperationOwned };
      executeAgentTurnMock.mockImplementation(async () => {
        expect(SessionManager.open(scope).buildSessionContext().messages).toEqual(
          messages.map((message) => expect.objectContaining(message)),
        );
        return {
          runId: "runtime-config-test",
          outcome: { kind: "rejected", payload: { text: "main reply" } },
        };
      });

      const result = await runReplyAgent(replyParams);

      expect(result).toEqual({ text: "main reply" });
      expect(followupRun.run.sessionId).toBe(sessionEntry.sessionId);
      expect(onReplyOperationOwned.mock.calls[0]?.[0].sessionId).toBe(sessionEntry.sessionId);
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: sessionEntry.sessionId,
        lifecycleRevision: sessionEntry.lifecycleRevision,
        compactionCount: 4,
        totalTokens: 100,
        totalTokensFresh: true,
        memoryFlush: { kind: "failed", failureCount: 2 },
      });
      expect(sessionStore[sessionKey]).toMatchObject({
        lifecycleRevision: sessionEntry.lifecycleRevision,
        compactionCount: 4,
        totalTokens: 100,
      });
      expect(runMemoryFlushIfNeededMock).not.toHaveBeenCalled();
      expect(runSessionCompactionIfNeededMock).toHaveBeenCalledOnce();
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(executeAgentTurnMock).toHaveBeenCalledOnce();
    });
  });

  it.each(["compaction failure", "compaction abort", "memory flush"] as const)(
    "keeps the ingress watchdog live during %s and stops its heartbeat afterward",
    async (phase) => {
      const memoryFlush = phase === "memory flush";
      await useRealMaintenance({ flush: memoryFlush });
      if (memoryFlush) {
        registerMemoryFlush(1_000_000_000);
      }
      await withTestDir({ prefix: "openclaw-maintenance-heartbeat-" }, async (tempDir) => {
        const { replyParams, followupRun, sessionEntry } = await createStoredReply(tempDir, {
          totalTokens: 95_000,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        });
        Object.assign(followupRun.run, {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          ...(memoryFlush ? { workspaceDir: tempDir } : {}),
        });
        const onReplyOperationOwned = vi.fn<(operation: ReplyOperation) => void>();
        const lifecycle = {
          admission: "exclusive" as const,
          onAdopted: vi.fn(),
          onDeferredHeartbeat: vi.fn(),
          deferredHeartbeatIntervalMs: 100,
          ...(!memoryFlush
            ? {
                abortSignal: new AbortController().signal,
                onDeferred: vi.fn(),
                onAbandoned: vi.fn(),
              }
            : {}),
        };
        followupRun.turnAdoptionLifecycle = lifecycle;
        replyParams.opts = {
          turnAdoptionLifecycle: lifecycle,
          ...(!memoryFlush ? { onReplyOperationOwned } : {}),
        };
        const cfg = configureContext(
          { followupRun, replyParams },
          memoryFlush ? { agents: { defaults: { compaction: { memoryFlush: {} } } } } : {},
        );
        if (memoryFlush) {
          setRuntimeConfigSnapshot(cfg);
          onTestFinished(() => clearRuntimeConfigSnapshot());
        } else {
          runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry, outcome: "skipped" });
        }
        const entered = createDeferred();
        const release = createDeferred();
        const paused = async () => {
          entered.resolve();
          await release.promise;
        };
        if (memoryFlush) {
          runEmbeddedAgentMock.mockImplementationOnce(async () => {
            await paused();
            return { payloads: [], meta: {} };
          });
        } else {
          compactEmbeddedAgentSessionMock.mockReset().mockImplementation(async () => {
            await paused();
            if (phase === "compaction failure") {
              throw new Error("Preflight compaction required but failed: test failure");
            }
            return { ok: true, compacted: true, result: { tokensAfter: 42 } };
          });
        }
        vi.useFakeTimers();
        const pending = runReplyAgent(replyParams);
        try {
          if (memoryFlush) {
            await expect(
              Promise.race([
                entered.promise.then(() => "entered"),
                pending.then(() => "completed-before-flush"),
              ]),
            ).resolves.toBe("entered");
          } else {
            await entered.promise;
          }
          await vi.advanceTimersByTimeAsync(350);
          if (!memoryFlush) {
            expect(lifecycle.onAdopted).not.toHaveBeenCalled();
          }
          expect(lifecycle.onDeferredHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
          if (phase === "compaction abort") {
            expect(onReplyOperationOwned.mock.calls[0]?.[0].abortByUser()).toBe(true);
            lifecycle.onDeferredHeartbeat.mockClear();
            await vi.advanceTimersByTimeAsync(500);
            expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
          }
          release.resolve();
          if (memoryFlush) {
            await expect(pending).resolves.toEqual({ text: "main reply" });
            expect(lifecycle.onAdopted).toHaveBeenCalledOnce();
          } else {
            await pending;
          }
          lifecycle.onDeferredHeartbeat.mockClear();
          await vi.advanceTimersByTimeAsync(500);
          expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
          if (memoryFlush) {
            expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
          }
        } finally {
          release.resolve();
          await Promise.allSettled([pending]);
          vi.useRealTimers();
        }
      });
    },
  );

  it("keeps the compacted session when preflight recovers an exhausted memory flush", async () => {
    const { replyParams, followupRun } = createDirectRuntimeReplyParams();
    const sessionEntry = {
      sessionId: "session-1",
      lifecycleRevision: "original-generation",
      updatedAt: 1,
      compactionCount: 4,
    };
    replyParams.sessionEntry = sessionEntry;
    runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry, outcome: "exhausted" });
    runSessionCompactionIfNeededMock.mockImplementation(async (params: PreflightParams) => {
      expect(params.sessionEntry?.sessionId).toBe("session-1");
      const checkpointed = await runRequiredCheckpoint(params);
      return { ...checkpointed, compactionCount: 5 };
    });

    await expect(runReplyAgent(replyParams)).resolves.toEqual({ text: "main reply" });

    expect(followupRun.run.sessionId).toBe(sessionEntry.sessionId);
    expect(executeAgentTurnMock).toHaveBeenCalledOnce();
    expect(executeAgentTurnMock.mock.calls[0]?.[0].getActiveSessionEntry()).toEqual({
      ...sessionEntry,
      compactionCount: 5,
    });
  });

  it("records restart during memory flush as cancellation without starting the main turn", async () => {
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

    expect(result).toMatchObject({
      text: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
    });
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

  it("surfaces known pre-run Codex usage-limit failures instead of dropping the reply", async () => {
    const { replyParams } = createDirectRuntimeReplyParams();
    const codexMessage =
      "You've reached your Codex subscription usage limit. Codex did not return a reset time for this limit. Run /codex account for current usage details.";
    runSessionCompactionIfNeededMock.mockRejectedValue(
      new FailoverError(codexMessage, {
        reason: "rate_limit",
        provider: "openai",
        model: "gpt-5.5",
      }),
    );
    runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry: undefined, outcome: "skipped" });

    const result = await runReplyAgent(replyParams);

    if (!result || Array.isArray(result)) {
      throw new Error("expected a single usage-limit reply payload");
    }
    expect(result.text).toBe(`⚠️ ${codexMessage}`);
    const metadata = getReplyPayloadMetadata(result);
    expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("delivers known pre-run OAuth refresh failures instead of dropping the reply", async () => {
    const { replyParams } = createDirectRuntimeReplyParams();
    runSessionCompactionIfNeededMock.mockRejectedValue(
      new OAuthRefreshFailureError({ provider: "openai", message: "refresh_token_invalidated" }),
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

    const metadata = getReplyPayloadMetadata(result);
    expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(executeAgentTurnMock).not.toHaveBeenCalled();
    expect(delivered).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: expect.stringContaining("/login openai"), isError: true }),
      "final",
    );
    expect(delivered.mock.calls[0]?.[0].presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [{ label: "Sign in", action: { type: "command", command: "/login openai" } }],
        },
      ],
    });
  });

  it.each([
    { source: "current", revokeDuring: undefined, kept: true },
    { source: "revoked during preflight", revokeDuring: "preflight", kept: false },
    { source: "revoked while the append awaits", revokeDuring: "persist", kept: false },
    { source: "revoked original input", revokeDuring: "source", kept: false },
  ] as const)(
    "keeps the user turn after a failed required preflight only for a $source source",
    async ({ revokeDuring, kept }) => {
      await withTestDir({ prefix: "openclaw-preflight-user-turn-" }, async (tempDir) => {
        const { replyParams, followupRun, sessionEntry, scope } = await createStoredReply(tempDir);
        await appendTranscriptMessage(scope, { message: { role: "user", content: "earlier" } });
        let revoked = false;
        const input = {
          text: "the turn that hit the failed preflight",
          idempotencyKey: "source-1",
        };
        followupRun.userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
          input,
          assertOriginalInputCommit: () => {
            if (revokeDuring === "source") {
              throw new Error("original input source revoked");
            }
          },
          // Message resolution is the first await inside persistApproved().
          resolveInput: async () => {
            revoked ||= revokeDuring === "persist";
            return input;
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
        runSessionCompactionIfNeededMock.mockImplementation(async () => {
          revoked = revokeDuring === "preflight";
          throw new Error("Preflight compaction required but failed: summarization_failed");
        });

        const result = await runReplyAgent(replyParams);

        expect(result).toMatchObject({ text: expect.stringContaining("couldn't shorten it") });
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
    const { followupRun, resolvedQueue, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: true,
      isActive: true,
    });
    const runState: ReplyOperationRunState = {};
    replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
    enqueueFollowupRunMock.mockReturnValueOnce(true);

    await expect(runReplyAgent(replyParams)).resolves.toBeUndefined();

    expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
    expect(resolveQueuedReplyExecutionConfigMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalledTimes(1);
    const enqueueCall = enqueueFollowupRunMock.mock.calls.at(0);
    expect(enqueueCall?.[0]).toBe("main");
    expect(enqueueCall?.[1]).toBe(followupRun);
    expect(enqueueCall?.[2]).toBe(resolvedQueue);
    expect(enqueueCall?.[3]).toBe("message-id");
    expect(typeof enqueueCall?.[4]).toBe("function");
    expect(enqueueCall?.[5]).toBe(false);
  });
});
