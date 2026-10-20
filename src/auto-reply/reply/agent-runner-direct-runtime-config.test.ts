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
  listSessionPendingInputs,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import {
  createReplyOperation as createSessionReplyOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
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
  staleCfg,
} from "./agent-runner-direct-runtime-config.test-fixtures.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import * as agentRunnerResult from "./agent-runner-result.js";
import { withTestModelContextTokens } from "./agent-runner.test-fixtures.js";
import type { FollowupRun } from "./queue.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";

const freshCfg = { runtimeFresh: true };
const sentinelError = new Error("stop-after-preflight");

const resolveQueuedReplyExecutionConfigMock = vi.fn();
const resolveReplyToModeMock = vi.fn();
const createReplyToModeFilterForChannelMock = vi.fn();
const createReplyMediaContextMock = vi.fn();
const createReplyMediaPathNormalizerMock = vi.fn();
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

vi.mock("./agent-runner-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
  return {
    ...actual,
    resolveQueuedReplyExecutionConfig: (...args: unknown[]) =>
      resolveQueuedReplyExecutionConfigMock(...args),
  };
});

vi.mock("./reply-threading.js", async () => {
  const actual =
    await vi.importActual<typeof import("./reply-threading.js")>("./reply-threading.js");
  return {
    ...actual,
    resolveReplyToMode: (...args: unknown[]) => resolveReplyToModeMock(...args),
    createReplyToModeFilterForChannel: (...args: unknown[]) =>
      createReplyToModeFilterForChannelMock(...args),
  };
});

vi.mock("./reply-media-paths.js", () => ({
  createReplyMediaContext: (...args: unknown[]) => {
    createReplyMediaContextMock(...args);
    return {
      normalizePayload: createReplyMediaPathNormalizerMock(...args),
    };
  },
  createReplyMediaPathNormalizer: (...args: unknown[]) =>
    createReplyMediaPathNormalizerMock(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runSessionCompactionIfNeeded: (...args: unknown[]) => runSessionCompactionIfNeededMock(...args),
  runMemoryFlushIfNeeded: (...args: unknown[]) => runMemoryFlushIfNeededMock(...args),
}));

vi.mock("./agent-runner-execution.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-runner-execution.js")>(
    "./agent-runner-execution.js",
  );
  return {
    ...actual,
    executeAgentTurn: (...args: unknown[]) => executeAgentTurnMock(...args),
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
  };
});

const { runReplyAgent } = await import("./agent-runner-run.js");

type TestReplyOperation = ReplyOperation & {
  setPhase: ReturnType<typeof vi.fn<ReplyOperation["setPhase"]>>;
};

function createOwnedReplyOperation(upstreamAbortSignal?: AbortSignal): ReplyOperation {
  const operation = createSessionReplyOperation({
    sessionKey: directSessionKey,
    sessionId: "session-1",
    resetTriggered: false,
    upstreamAbortSignal,
  });
  onTestFinished(async () => {
    operation.complete();
    await operation.ownerSettlement;
  });
  return operation;
}

function createReplyOperation(): TestReplyOperation {
  const replyOperation = createOwnedReplyOperation();
  const setPhase = vi.spyOn(replyOperation, "setPhase");
  return Object.assign(replyOperation, { setPhase });
}

function requireResolveQueuedReplyExecutionConfigCall(index = 0) {
  const call = resolveQueuedReplyExecutionConfigMock.mock.calls[index] as
    | [
        unknown,
        {
          originatingChannel?: string;
          messageProvider?: string;
        },
      ]
    | undefined;
  if (!call) {
    throw new Error(`resolveQueuedReplyExecutionConfig call ${index} missing`);
  }
  return call;
}

type MockCallSource = {
  mock: {
    calls: unknown[][];
  };
};

function requireMaintenanceCall(mock: MockCallSource, name: string, index = 0) {
  const call = mock.mock.calls[index]?.[0] as
    | {
        cfg?: unknown;
        followupRun?: FollowupRun;
        sessionKey?: string;
        runtimePolicySessionKey?: string;
      }
    | undefined;
  if (!call) {
    throw new Error(`${name} call ${index} missing`);
  }
  return call;
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
    createReplyToModeFilterForChannelMock.mockReset();
    createReplyMediaContextMock.mockReset();
    createReplyMediaPathNormalizerMock.mockReset();
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
    resolveReplyToModeMock.mockReturnValue("all");
    createReplyToModeFilterForChannelMock.mockReturnValue((payload: unknown) => payload);
    createReplyMediaPathNormalizerMock.mockReturnValue((payload: unknown) => payload);
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

  it.each(["completed", "failed"] as const)(
    "reports one %s terminal outcome after finalization settles",
    async (outcome) => {
      const { replyParams } = createDirectRuntimeReplyParams();
      const onAgentRunTerminalOutcome = vi.fn();
      replyParams.opts = { onAgentRunTerminalOutcome };
      runSessionCompactionIfNeededMock.mockImplementation(runRequiredCheckpoint);
      executeAgentTurnMock.mockImplementationOnce(async (params: AgentTurnParams) => {
        params.opts?.onAgentRunTerminalOutcome?.("completed");
        return {
          runId: "runtime-config-test",
          outcome: {
            kind: "settled",
            status: "ok",
            result: { payloads: [], meta: {} },
            resolved: { provider: "openai", model: "gpt-5.4" },
            fallback: { exhausted: false, attempts: [] },
            autoCompactionCount: 0,
            didLogHeartbeatStrip: false,
          },
        };
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
        expect(finalize).toHaveBeenCalledOnce();
        expect(onAgentRunTerminalOutcome).toHaveBeenCalledExactlyOnceWith(outcome);
      } finally {
        finalize.mockRestore();
      }
    },
  );

  it("reports a queued recovery failure after the parent terminal outcome", async () => {
    await withTestDir({ prefix: "openclaw-terminal-recovery-" }, async (tempDir) => {
      const { replyParams, followupRun } = createDirectRuntimeReplyParams();
      const sessionKey = directSessionKey;
      const sessionEntry: SessionEntry = {
        sessionId: followupRun.run.sessionId,
        lifecycleRevision: "terminal-recovery",
        updatedAt: 1,
      };
      const storePath = join(tempDir, "sessions.json");
      await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
      replyParams.sessionKey = sessionKey;
      replyParams.queueKey = sessionKey;
      replyParams.storePath = storePath;
      replyParams.sessionEntry = sessionEntry;
      replyParams.sessionStore = { [sessionKey]: sessionEntry };
      followupRun.run.workspaceDir = tempDir;
      const onAgentRunTerminalOutcome = vi.fn();
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
          return {
            runId: "parent-turn",
            outcome: {
              kind: "settled",
              status: "ok",
              result: {
                payloads: [{ text: finalText }],
                meta: {
                  finalAssistantVisibleText: finalText,
                  terminalReply: { disposition: "visible", text: finalText },
                },
              },
              resolved: { provider: "openai", model: "gpt-5.4" },
              fallback: { exhausted: false, attempts: [] },
              autoCompactionCount: 0,
              didLogHeartbeatStrip: false,
            },
          };
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
        expect(executeAgentTurnMock).toHaveBeenCalledTimes(2);
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

  it("resolves direct reply runs before early helpers read config", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams();
    const onAgentRunTerminalOutcome = vi.fn();
    replyParams.opts = { onAgentRunTerminalOutcome };

    await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);

    expect(onAgentRunTerminalOutcome).not.toHaveBeenCalled();
    expect(followupRun.run.config).toBe(freshCfg);
    expect(resolveQueuedReplyExecutionConfigMock).toHaveBeenCalledTimes(1);
    const [configArg, configContextArg] = requireResolveQueuedReplyExecutionConfigCall();
    expect(configArg).toEqual(staleCfg);
    expect(configContextArg.originatingChannel).toBe("telegram");
    expect(configContextArg.messageProvider).toBe("telegram");
    expect(resolveReplyToModeMock).toHaveBeenCalledWith(freshCfg, "telegram", "default", "dm");
    expect(createReplyMediaContextMock).toHaveBeenCalledWith({
      cfg: freshCfg,
      agentId: "main",
      sessionKey: undefined,
      workspaceDir: followupRun.run.workspaceDir,
      messageProvider: "telegram",
      accountId: undefined,
      groupId: undefined,
      groupChannel: undefined,
      groupSpace: undefined,
      requesterSenderId: undefined,
      requesterSenderName: undefined,
      requesterSenderUsername: undefined,
      requesterSenderE164: undefined,
    });
    expect(runSessionCompactionIfNeededMock).toHaveBeenCalledTimes(1);
    expect(runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(1);
    expect(runSessionCompactionIfNeededMock.mock.invocationCallOrder[0]).toBeLessThan(
      runMemoryFlushIfNeededMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const memoryCall = requireMaintenanceCall(runMemoryFlushIfNeededMock, "runMemoryFlushIfNeeded");
    expect(memoryCall.cfg).toBe(freshCfg);
    const preflightCall = requireMaintenanceCall(
      runSessionCompactionIfNeededMock,
      "runSessionCompactionIfNeeded",
    );
    expect(preflightCall.cfg).toBe(freshCfg);
    expect(memoryCall.followupRun).toBe(preflightCall.followupRun);
    expect(memoryCall.followupRun).toMatchObject({
      originatingChannel: "telegram",
      originatingTo: "12345",
      run: { config: freshCfg },
    });
  });

  it("passes the derived runtime-policy key to pre-run maintenance", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams();
    const runtimePolicySessionKey = "agent:main:telegram:default:direct:test";
    followupRun.run.sessionKey = "agent:main:main";
    followupRun.run.runtimePolicySessionKey = runtimePolicySessionKey;
    replyParams.queueKey = followupRun.run.sessionKey;
    replyParams.sessionKey = "agent:main:main";
    replyParams.runtimePolicySessionKey = runtimePolicySessionKey;

    await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);

    expect(followupRun.run.config).toBe(freshCfg);
    const [configArg, configContextArg] = requireResolveQueuedReplyExecutionConfigCall();
    expect(configArg).toEqual(staleCfg);
    expect(configContextArg).toMatchObject({
      originatingChannel: "telegram",
      messageProvider: "telegram",
    });
    expect(resolveReplyToModeMock).toHaveBeenCalledWith(freshCfg, "telegram", "default", "dm");
    const preflightCall = requireMaintenanceCall(
      runSessionCompactionIfNeededMock,
      "runSessionCompactionIfNeeded",
    );
    expect(preflightCall.sessionKey).toBe("agent:main:main");
    expect(preflightCall.runtimePolicySessionKey).toBe(runtimePolicySessionKey);
    expect(preflightCall.cfg).toBe(freshCfg);
    const memoryCall = requireMaintenanceCall(runMemoryFlushIfNeededMock, "runMemoryFlushIfNeeded");
    expect(memoryCall.sessionKey).toBe("agent:main:main");
    expect(memoryCall.runtimePolicySessionKey).toBe(runtimePolicySessionKey);
    expect(memoryCall.cfg).toBe(freshCfg);
  });

  it("continues the main reply after a recorded memory-flush failure", async () => {
    const { replyParams } = createDirectRuntimeReplyParams();
    const onBlockReply = vi.fn();
    const replyOperation = createReplyOperation();
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
    const memory = await vi.importActual<typeof import("./agent-runner-memory.js")>(
      "./agent-runner-memory.js",
    );
    runMemoryFlushIfNeededMock.mockImplementation(memory.runMemoryFlushIfNeeded);
    runSessionCompactionIfNeededMock.mockImplementation(memory.runSessionCompactionIfNeeded);
    registerMemoryCapability("memory-core", {
      flushPlanResolver: () => ({
        softThresholdTokens: 4_000,
        forceFlushTranscriptBytes: 1,
        reserveTokensFloor: 20_000,
        prompt: "Save durable notes. NO_REPLY",
        systemPrompt: "Write memory to memory/notes.md.",
        relativePath: "memory/notes.md",
      }),
    });
    try {
      await withTestDir({ prefix: "openclaw-direct-runtime-" }, async (tempDir) => {
        const { replyParams, followupRun } = createDirectRuntimeReplyParams();
        const sessionKey = directSessionKey;
        const sessionEntry: SessionEntry = {
          sessionId: "session-1",
          lifecycleRevision: "before-maintenance",
          updatedAt: 1,
          totalTokens: 100,
          totalTokensFresh: true,
          totalTokensVersion: 1,
          compactionCount: 4,
          memoryFlush: { kind: "failed", failureCount: 2 },
        };
        const sessionStore = { [sessionKey]: sessionEntry };
        const storePath = join(tempDir, "sessions.json");
        const scope = { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath };
        await replaceSessionEntry(scope, sessionEntry);
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
        followupRun.run.config = { ...followupRun.run.config, session: { store: storePath } };
        followupRun.run.workspaceDir = tempDir;
        followupRun.run.provider = "anthropic";
        followupRun.run.model = "claude-sonnet-4-6";
        replyParams.sessionKey = sessionKey;
        replyParams.storePath = storePath;
        replyParams.sessionEntry = sessionEntry;
        replyParams.sessionStore = sessionStore;
        resolveQueuedReplyExecutionConfigMock.mockResolvedValue(
          withTestModelContextTokens({
            cfg: {
              session: { store: storePath },
              agents: { defaults: { compaction: { notifyUser: true } } },
            },
            followupRun,
            defaultModel: replyParams.defaultModel,
            contextTokens: 100_000,
          }),
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
    } finally {
      clearMemoryPluginState();
    }
  });

  it.each(["failure", "operation abort"] as const)(
    "keeps preflight compaction live and stops its heartbeat after %s",
    async (outcome) => {
      const memory = await vi.importActual<typeof import("./agent-runner-memory.js")>(
        "./agent-runner-memory.js",
      );
      runSessionCompactionIfNeededMock.mockImplementation(memory.runSessionCompactionIfNeeded);
      await withTestDir({ prefix: "openclaw-preflight-heartbeat-" }, async (tempDir) => {
        const { replyParams, followupRun } = createDirectRuntimeReplyParams({
          shouldFollowup: false,
          isActive: false,
        });
        const sessionKey = directSessionKey;
        const sessionEntry: SessionEntry = {
          sessionId: "session-1",
          updatedAt: 1,
          totalTokens: 95_000,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        };
        const storePath = join(tempDir, "sessions.json");
        await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, sessionEntry);
        followupRun.run.config = { ...followupRun.run.config, session: { store: storePath } };
        followupRun.run.provider = "anthropic";
        followupRun.run.model = "claude-sonnet-4-6";
        const abort = new AbortController();
        const onReplyOperationOwned = vi.fn<(operation: ReplyOperation) => void>();
        const lifecycle = {
          admission: "exclusive" as const,
          abortSignal: abort.signal,
          onAdopted: vi.fn(),
          onDeferred: vi.fn(),
          onDeferredHeartbeat: vi.fn(),
          deferredHeartbeatIntervalMs: 100,
          onAbandoned: vi.fn(),
        };
        followupRun.turnAdoptionLifecycle = lifecycle;
        replyParams.opts = { turnAdoptionLifecycle: lifecycle, onReplyOperationOwned };
        replyParams.sessionKey = sessionKey;
        replyParams.sessionEntry = sessionEntry;
        replyParams.sessionStore = { [sessionKey]: sessionEntry };
        replyParams.storePath = storePath;
        resolveQueuedReplyExecutionConfigMock.mockResolvedValue(
          withTestModelContextTokens({
            cfg: { session: { store: storePath } },
            followupRun,
            defaultModel: replyParams.defaultModel,
            contextTokens: 100_000,
          }),
        );
        runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry, outcome: "skipped" });
        const entered = createDeferred();
        const release = createDeferred();
        compactEmbeddedAgentSessionMock.mockReset().mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          if (outcome === "failure") {
            throw new Error("Preflight compaction required but failed: test failure");
          }
          return { ok: true, compacted: true, result: { tokensAfter: 42 } };
        });
        vi.useFakeTimers();
        const pending = runReplyAgent(replyParams);
        try {
          await entered.promise;
          await vi.advanceTimersByTimeAsync(350);
          expect(lifecycle.onAdopted).not.toHaveBeenCalled();
          expect(lifecycle.onDeferredHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
          if (outcome === "operation abort") {
            expect(onReplyOperationOwned.mock.calls[0]?.[0].abortByUser()).toBe(true);
            lifecycle.onDeferredHeartbeat.mockClear();
            await vi.advanceTimersByTimeAsync(500);
            expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
          }
          release.resolve();
          await pending;
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

  it.each([{ name: "runnable", totalTokens: 95_000, expectedHeartbeats: 2 }])(
    "keeps the ingress watchdog scoped around $name memory flush",
    async (testCase) => {
      const memory = await vi.importActual<typeof import("./agent-runner-memory.js")>(
        "./agent-runner-memory.js",
      );
      runMemoryFlushIfNeededMock.mockImplementation(memory.runMemoryFlushIfNeeded);
      runSessionCompactionIfNeededMock.mockImplementation(memory.runSessionCompactionIfNeeded);
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
      try {
        await withTestDir({ prefix: "openclaw-memory-heartbeat-" }, async (tempDir) => {
          const { replyParams, followupRun } = createDirectRuntimeReplyParams({
            shouldFollowup: false,
            isActive: false,
          });
          const sessionKey = "agent:main:telegram:default:direct:test";
          const sessionEntry: SessionEntry = {
            sessionId: "session-1",
            updatedAt: 1,
            totalTokens: testCase.totalTokens,
            totalTokensFresh: true,
            totalTokensVersion: 1,
          };
          const storePath = join(tempDir, "sessions.json");
          await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, sessionEntry);
          followupRun.run.config = { ...followupRun.run.config, session: { store: storePath } };
          followupRun.run.workspaceDir = tempDir;
          followupRun.run.provider = "anthropic";
          followupRun.run.model = "claude-sonnet-4-6";
          const lifecycle = {
            admission: "exclusive" as const,
            onAdopted: vi.fn(),
            onDeferredHeartbeat: vi.fn(),
            deferredHeartbeatIntervalMs: 100,
          };
          followupRun.turnAdoptionLifecycle = lifecycle;
          replyParams.opts = { turnAdoptionLifecycle: lifecycle };
          replyParams.sessionKey = sessionKey;
          replyParams.sessionEntry = sessionEntry;
          replyParams.sessionStore = { [sessionKey]: sessionEntry };
          replyParams.storePath = storePath;
          const cfg = withTestModelContextTokens({
            cfg: {
              session: { store: storePath },
              agents: { defaults: { compaction: { memoryFlush: {} } } },
            },
            followupRun,
            defaultModel: replyParams.defaultModel,
            contextTokens: 100_000,
          });
          resolveQueuedReplyExecutionConfigMock.mockResolvedValue(cfg);
          setRuntimeConfigSnapshot(cfg);
          onTestFinished(() => clearRuntimeConfigSnapshot());
          const entered = createDeferred();
          const release = createDeferred();
          runEmbeddedAgentMock.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return { payloads: [], meta: {} };
          });
          vi.useFakeTimers();
          const pending = runReplyAgent(replyParams);
          try {
            if (testCase.expectedHeartbeats > 0) {
              await expect(
                Promise.race([
                  entered.promise.then(() => "entered"),
                  pending.then(() => "completed-before-flush"),
                ]),
              ).resolves.toBe("entered");
              await vi.advanceTimersByTimeAsync(350);
              expect(lifecycle.onDeferredHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(
                testCase.expectedHeartbeats,
              );
              release.resolve();
            }
            await expect(pending).resolves.toEqual({ text: "main reply" });
            expect(lifecycle.onAdopted).toHaveBeenCalledOnce();
            lifecycle.onDeferredHeartbeat.mockClear();
            await vi.advanceTimersByTimeAsync(500);
            expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
            expect(runEmbeddedAgentMock).toHaveBeenCalledTimes(
              testCase.expectedHeartbeats > 0 ? 1 : 0,
            );
          } finally {
            release.resolve();
            await Promise.allSettled([pending]);
            vi.useRealTimers();
          }
        });
      } finally {
        clearMemoryPluginState();
      }
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
    replyParams.sessionKey = directSessionKey;
    replyParams.sessionEntry = sessionEntry;
    runMemoryFlushIfNeededMock.mockResolvedValue({
      sessionEntry,
      outcome: "exhausted",
    });
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

  it.each(["abortForRestart"] as const)(
    "records %s during memory flush as cancellation without starting the main turn",
    async (abortMethod) => {
      const { replyParams } = createDirectRuntimeReplyParams();
      const runState: ReplyOperationRunState = {};
      replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
      runSessionCompactionIfNeededMock.mockImplementation(runRequiredCheckpoint);
      runMemoryFlushIfNeededMock.mockImplementation(
        async (params: { replyOperation: ReplyOperation }) => {
          expect(params.replyOperation[abortMethod]()).toBe(true);
          return { sessionEntry: undefined, outcome: "failed" };
        },
      );

      const result = await runReplyAgent(replyParams);

      expect(result).toMatchObject({
        text: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      });
      expect(resolveReplyOperationAgentTurn(runState)).toBe("cancelled");
      expect(executeAgentTurnMock).not.toHaveBeenCalled();
    },
  );

  it.each(["user"] as const)("records an aborted %s agent turn as cancellation", async (reason) => {
    const { replyParams } = createDirectRuntimeReplyParams();
    const runState: ReplyOperationRunState = {};
    replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
    runSessionCompactionIfNeededMock.mockResolvedValue(undefined);
    executeAgentTurnMock.mockResolvedValue({
      runId: "cancelled-runtime-config-test",
      outcome: { kind: "aborted", reason },
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
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
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
        const { replyParams, followupRun } = createDirectRuntimeReplyParams();
        const sessionKey = "agent:main:telegram:default:direct:test";
        const sessionEntry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
        const storePath = join(tempDir, "sessions.json");
        followupRun.run.config = { ...followupRun.run.config, session: { store: storePath } };
        const scope = { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath };
        await replaceSessionEntry(scope, sessionEntry);
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
        replyParams.sessionKey = sessionKey;
        replyParams.storePath = storePath;
        replyParams.sessionEntry = sessionEntry;
        replyParams.sessionStore = { [sessionKey]: sessionEntry };
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
    const { followupRun, resolvedQueue, replyParams } = createDirectRuntimeReplyParams({
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
    expect(enqueueFollowupRunMock).toHaveBeenCalledTimes(1);
    const enqueueCall = enqueueFollowupRunMock.mock.calls.at(0);
    expect(enqueueCall?.[0]).toBe(directSessionKey);
    expect(enqueueCall?.[1]).toBe(followupRun);
    expect(enqueueCall?.[2]).toBe(resolvedQueue);
    expect(enqueueCall?.[3]).toBe("message-id");
    expect(typeof enqueueCall?.[4]).toBe("function");
    expect(enqueueCall?.[5]).toBe(false);
  });
});
