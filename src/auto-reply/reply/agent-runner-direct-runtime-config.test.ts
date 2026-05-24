import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import type { QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const freshCfg = { runtimeFresh: true };
const staleCfg = {
  runtimeFresh: false,
  skills: {
    entries: {
      whisper: {
        apiKey: { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" },
      },
    },
  },
};
const sentinelError = new Error("stop-after-preflight");

const resolveQueuedReplyExecutionConfigMock = vi.fn();
const resolveReplyToModeMock = vi.fn();
const createReplyToModeFilterForChannelMock = vi.fn();
const createReplyMediaContextMock = vi.fn();
const createReplyMediaPathNormalizerMock = vi.fn();
const runPreflightCompactionIfNeededMock = vi.fn();
const runMemoryFlushIfNeededMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

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

const registerPendingMemoryFlushMock = vi.fn();

vi.mock("./agent-runner-memory.js", () => ({
  runPreflightCompactionIfNeeded: (...args: unknown[]) =>
    runPreflightCompactionIfNeededMock(...args),
  runMemoryFlushIfNeeded: (...args: unknown[]) => runMemoryFlushIfNeededMock(...args),
  registerPendingMemoryFlush: (...args: unknown[]) => registerPendingMemoryFlushMock(...args),
}));

const runAgentTurnWithFallbackMock = vi.fn();

vi.mock("./agent-runner-execution.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-runner-execution.js")>(
    "./agent-runner-execution.js",
  );
  return {
    ...actual,
    runAgentTurnWithFallback: (...args: unknown[]) => runAgentTurnWithFallbackMock(...args),
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
  };
});

const { runReplyAgent } = await import("./agent-runner.js");

function createTelegramSessionCtx(): TemplateContext {
  return {
    Provider: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "12345",
    AccountId: "default",
    ChatType: "dm",
    MessageSid: "msg-1",
  } as unknown as TemplateContext;
}

function createDirectRuntimeReplyParams({
  shouldFollowup,
  isActive,
}: {
  shouldFollowup: boolean;
  isActive: boolean;
}) {
  const followupRun = createTestFollowupRun({
    sessionId: "session-1",
    sessionKey: "agent:main:telegram:default:direct:test",
    messageProvider: "telegram",
    config: staleCfg,
    provider: "openai",
    model: "gpt-5.4",
  });
  const resolvedQueue = { mode: "interrupt" } as QueueSettings;
  const replyParams: Parameters<typeof runReplyAgent>[0] = {
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup,
    isActive,
    isStreaming: false,
    typing: createMockTypingController(),
    sessionCtx: createTelegramSessionCtx(),
    defaultModel: "openai/gpt-5.4",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  };

  return { followupRun, resolvedQueue, replyParams };
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
        followupRun?: unknown;
        sessionKey?: string;
        runtimePolicySessionKey?: string;
      }
    | undefined;
  if (!call) {
    throw new Error(`${name} call ${index} missing`);
  }
  return call;
}

describe("runReplyAgent runtime config", () => {
  beforeEach(() => {
    resolveQueuedReplyExecutionConfigMock.mockReset();
    resolveReplyToModeMock.mockReset();
    createReplyToModeFilterForChannelMock.mockReset();
    createReplyMediaContextMock.mockReset();
    createReplyMediaPathNormalizerMock.mockReset();
    runPreflightCompactionIfNeededMock.mockReset();
    runMemoryFlushIfNeededMock.mockReset();
    registerPendingMemoryFlushMock.mockReset();
    runAgentTurnWithFallbackMock.mockReset();
    enqueueFollowupRunMock.mockReset();

    resolveQueuedReplyExecutionConfigMock.mockResolvedValue(freshCfg);
    resolveReplyToModeMock.mockReturnValue("default");
    createReplyToModeFilterForChannelMock.mockReturnValue((payload: unknown) => payload);
    createReplyMediaPathNormalizerMock.mockReturnValue((payload: unknown) => payload);
    runPreflightCompactionIfNeededMock.mockRejectedValue(sentinelError);
    runMemoryFlushIfNeededMock.mockResolvedValue(undefined);
  });

  it("resolves direct reply runs before early helpers read config", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });

    await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);

    expect(followupRun.run.config).toBe(freshCfg);
    expect(resolveQueuedReplyExecutionConfigMock).toHaveBeenCalledTimes(1);
    const [configArg, configContextArg] = requireResolveQueuedReplyExecutionConfigCall();
    expect(configArg).toBe(staleCfg);
    expect(configContextArg.originatingChannel).toBe("telegram");
    expect(configContextArg.messageProvider).toBe("telegram");
    expect(resolveReplyToModeMock).toHaveBeenCalledWith(freshCfg, "telegram", "default", "dm");
    expect(createReplyMediaContextMock).toHaveBeenCalledWith({
      cfg: freshCfg,
      sessionKey: undefined,
      workspaceDir: "/tmp",
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
    expect(runPreflightCompactionIfNeededMock).toHaveBeenCalledTimes(1);
    const preflightCall = requireMaintenanceCall(
      runPreflightCompactionIfNeededMock,
      "runPreflightCompactionIfNeeded",
    );
    expect(preflightCall.cfg).toBe(freshCfg);
    expect(preflightCall.followupRun).toBe(followupRun);
  });

  it("passes the derived runtime-policy key to preflight compaction", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const runtimePolicySessionKey = "agent:main:telegram:default:direct:test";
    followupRun.run.sessionKey = "agent:main:main";
    followupRun.run.runtimePolicySessionKey = runtimePolicySessionKey;
    replyParams.sessionKey = "agent:main:main";
    replyParams.runtimePolicySessionKey = runtimePolicySessionKey;
    runPreflightCompactionIfNeededMock.mockRejectedValue(sentinelError);

    await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);

    const preflightCall = requireMaintenanceCall(
      runPreflightCompactionIfNeededMock,
      "runPreflightCompactionIfNeeded",
    );
    expect(preflightCall.sessionKey).toBe("agent:main:main");
    expect(preflightCall.runtimePolicySessionKey).toBe(runtimePolicySessionKey);
    // The near-threshold memory flush is now dispatched after the user-visible
    // reply path; if preflight throws, the reply never runs and the flush is
    // not dispatched this turn.
    expect(runMemoryFlushIfNeededMock).not.toHaveBeenCalled();
  });

  it("dispatches the post-reply memory flush after the user-visible reply path returns", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const runtimePolicySessionKey = "agent:main:telegram:default:direct:test";
    followupRun.run.sessionKey = "agent:main:main";
    followupRun.run.runtimePolicySessionKey = runtimePolicySessionKey;
    replyParams.sessionKey = "agent:main:main";
    replyParams.runtimePolicySessionKey = runtimePolicySessionKey;
    runPreflightCompactionIfNeededMock.mockResolvedValue(undefined);
    runAgentTurnWithFallbackMock.mockResolvedValue({
      kind: "final",
      payload: { text: "ok" },
    });

    await runReplyAgent(replyParams);

    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(1);
    const memoryCall = runMemoryFlushIfNeededMock.mock.calls[0]?.[0] as
      | { sessionKey?: string; runtimePolicySessionKey?: string }
      | undefined;
    expect(memoryCall?.sessionKey).toBe("agent:main:main");
    expect(memoryCall?.runtimePolicySessionKey).toBe(runtimePolicySessionKey);
    expect(registerPendingMemoryFlushMock).toHaveBeenCalledTimes(1);
    expect(registerPendingMemoryFlushMock.mock.calls[0]?.[0]).toBe("agent:main:main");
    // Reply path's runAgentTurnWithFallback completed before the flush dispatch.
    expect(runAgentTurnWithFallbackMock.mock.invocationCallOrder[0]).toBeLessThan(
      runMemoryFlushIfNeededMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("dispatches the post-reply memory flush from the reply path's finally block even when the agent turn throws", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    followupRun.run.sessionKey = "agent:main:main";
    replyParams.sessionKey = "agent:main:main";
    runPreflightCompactionIfNeededMock.mockResolvedValue(undefined);
    const turnError = new Error("agent turn exploded");
    runAgentTurnWithFallbackMock.mockRejectedValue(turnError);

    await runReplyAgent(replyParams).catch(() => undefined);

    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(1);
    // Flush is still dispatched because the reply path was reached
    // (set right before runAgentTurnWithFallback was invoked).
    expect(runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(1);
    expect(registerPendingMemoryFlushMock).toHaveBeenCalledTimes(1);
    expect(runAgentTurnWithFallbackMock.mock.invocationCallOrder[0]).toBeLessThan(
      runMemoryFlushIfNeededMock.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("passes a maintenance ReplyOperation (NOT the completed reply's operation) into the post-reply memory flush", async () => {
    // ClawSweeper P1 regression guard: the deferred flush dispatched in the
    // reply orchestrator's finally block must not forward the (already
    // completed) reply ReplyOperation into runMemoryFlushIfNeeded. The
    // embedded runner calls attachBackend(...) on whatever ReplyOperation
    // it receives, and a completed operation cancels the attached handle
    // with "superseded", so the deferred flush would never reach its LLM
    // call.
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    followupRun.run.sessionKey = "agent:main:main";
    replyParams.sessionKey = "agent:main:main";

    // Provide an external ReplyOperation so the test owns the reference
    // for identity comparison and can observe its result transitions.
    const externalReplyOperation = (await import("./reply-run-registry.js")).createReplyOperation({
      sessionId: followupRun.run.sessionId,
      sessionKey: "agent:main:main",
      resetTriggered: false,
    });
    replyParams.replyOperation = externalReplyOperation;

    runPreflightCompactionIfNeededMock.mockResolvedValue(undefined);
    runAgentTurnWithFallbackMock.mockResolvedValue({
      kind: "final",
      payload: { text: "ok" },
    });

    await runReplyAgent(replyParams);

    // Confirm the reply operation has been terminated (completed or
    // failed) by the orchestrator before the post-reply flush runs.
    // Either terminal state engages the attachBackend cancellation
    // contract, which is exactly the path the maintenance op must not
    // share.
    expect(["completed", "failed"]).toContain(externalReplyOperation.result?.kind);

    expect(runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(1);
    const memoryCall = runMemoryFlushIfNeededMock.mock.calls[0]?.[0] as {
      replyOperation: {
        result: { kind: string } | null;
        attachBackend: (handle: { cancel: (reason: string) => void }) => void;
        complete: () => void;
        sessionId: string;
        key: string;
      };
    };
    expect(memoryCall.replyOperation).not.toBe(externalReplyOperation);
    // The maintenance op is not yet completed at the moment of dispatch:
    // it accepts a backend handle without immediately cancelling it.
    expect(memoryCall.replyOperation.result).toBe(null);

    const cancelMock = vi.fn();
    memoryCall.replyOperation.attachBackend({ cancel: cancelMock });
    expect(cancelMock).not.toHaveBeenCalled();

    // Compare: attaching to the (completed) reply operation would cancel.
    const cancelMockOnCompleted = vi.fn();
    externalReplyOperation.attachBackend({
      cancel: cancelMockOnCompleted,
      detach: vi.fn(),
    } as never);
    expect(cancelMockOnCompleted).toHaveBeenCalledWith("superseded");
  });

  it("aborts the maintenance ReplyOperation when the original reply operation aborts upstream", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    followupRun.run.sessionKey = "agent:main:main";
    replyParams.sessionKey = "agent:main:main";

    // Create a reply operation whose upstreamAbortSignal we control.
    const upstreamController = new AbortController();
    const externalReplyOperation = (await import("./reply-run-registry.js")).createReplyOperation({
      sessionId: followupRun.run.sessionId,
      sessionKey: "agent:main:main",
      resetTriggered: false,
      upstreamAbortSignal: upstreamController.signal,
    });
    replyParams.replyOperation = externalReplyOperation;

    runPreflightCompactionIfNeededMock.mockResolvedValue(undefined);
    runAgentTurnWithFallbackMock.mockResolvedValue({
      kind: "final",
      payload: { text: "ok" },
    });

    await runReplyAgent(replyParams);

    const memoryCall = runMemoryFlushIfNeededMock.mock.calls[0]?.[0] as {
      replyOperation: { abortSignal: AbortSignal };
    };
    expect(memoryCall.replyOperation.abortSignal.aborted).toBe(false);

    // Aborting the original reply's upstream signal must propagate into
    // the maintenance operation so a user cancel still stops the flush.
    upstreamController.abort(new Error("user cancelled"));
    expect(memoryCall.replyOperation.abortSignal.aborted).toBe(true);
  });

  it("does not block the start of the user-visible reply on a pending memory flush", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    followupRun.run.sessionKey = "agent:main:main";
    replyParams.sessionKey = "agent:main:main";
    runPreflightCompactionIfNeededMock.mockResolvedValue(undefined);
    // Memory flush returns a promise that never resolves within the test.
    runMemoryFlushIfNeededMock.mockImplementation(() => new Promise<undefined>(() => undefined));
    runAgentTurnWithFallbackMock.mockResolvedValue({
      kind: "final",
      payload: { text: "ok" },
    });

    const result = await runReplyAgent(replyParams);

    // Reply path completed even though the flush promise is still pending.
    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
    // Flush was dispatched (fire-and-forget) but never resolved.
    expect(runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(1);
    expect(registerPendingMemoryFlushMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces known pre-run Codex usage-limit failures instead of dropping the reply", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const codexMessage =
      "You've reached your Codex subscription usage limit. Codex did not return a reset time for this limit. Run /codex account for current usage details.";
    runPreflightCompactionIfNeededMock.mockRejectedValue(new Error(codexMessage));
    runMemoryFlushIfNeededMock.mockResolvedValue(undefined);

    const result = await runReplyAgent(replyParams);

    if (!result || Array.isArray(result)) {
      throw new Error("expected a single usage-limit reply payload");
    }
    expect(result.text).toBe(`⚠️ ${codexMessage}`);
    const metadata = getReplyPayloadMetadata(result);
    expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("does not resolve secrets before the enqueue-followup queue path", async () => {
    const { followupRun, resolvedQueue, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: true,
      isActive: true,
    });

    await expect(runReplyAgent(replyParams)).resolves.toBeUndefined();

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
