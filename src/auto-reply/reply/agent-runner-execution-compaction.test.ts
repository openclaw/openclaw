import { describe, expect, it, vi } from "vitest";
import { formatBillingErrorMessage } from "../../agents/failover/user-copy.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import * as autoFallback from "./agent-runner-auto-fallback.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createFollowupRun,
  initialFallbackAttemptOptions,
  expectBlockReplyCall,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";

const state = await setupAgentRunnerExecutionTestState();

async function executeTestTurn(
  params?: Parameters<typeof createMinimalRunAgentTurnParams>[0],
  overrides?: Partial<AgentTurnParams>,
) {
  const executeAgentTurn = await getExecuteAgentTurnForTest();
  return executeAgentTurn({ ...createMinimalRunAgentTurnParams(params), ...overrides });
}

function createNotifyUserRun() {
  const followupRun = createFollowupRun();
  followupRun.run.config = {
    agents: { defaults: { compaction: { notifyUser: true } } },
  };
  return followupRun;
}

type CompactionData = Parameters<NonNullable<EmbeddedAgentParams["onAgentEvent"]>>[0]["data"];

function mockCompaction(start: CompactionData = {}, end: CompactionData = {}) {
  state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
    await params.onAgentEvent?.({ stream: "compaction", data: { phase: "start", ...start } });
    await params.onAgentEvent?.({
      stream: "compaction",
      data: { phase: "end", completed: true, ...end },
    });
    return { payloads: [{ text: "final" }], meta: {} };
  });
}

function expectNotices(reply: ReturnType<typeof vi.fn>, texts: string[], addressed = false) {
  texts.forEach((text, index) => {
    expectBlockReplyCall(reply, index, {
      text,
      isCompactionNotice: true,
      ...(addressed ? { replyToId: "msg", replyToCurrent: true } : {}),
    });
  });
}

describe("executeAgentTurn: compaction events", () => {
  it("warns about degraded compaction even when ordinary notices are disabled", async () => {
    const onCompactionNoticePayload = vi.fn();
    mockCompaction({}, { qualityDegraded: true });
    const result = await executeTestTurn(undefined, { onCompactionNoticePayload });
    expect(result.kind).toBe("success");
    expect(onCompactionNoticePayload).toHaveBeenCalledOnce();
    expectBlockReplyCall(onCompactionNoticePayload, 0, {
      text: expect.stringContaining("Older details, exact identifiers, or pending requests"),
      isCompactionNotice: true,
    });
    expectBlockReplyCall(onCompactionNoticePayload, 0, {
      text: expect.stringContaining("/new or a larger model"),
    });
  });
  it("logs Codex app-server compaction completion while notices stay silent by default", async () => {
    const onBlockReply = vi.fn();
    const consoleLog = vi.fn();
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    loggingState.rawConsole = {
      log: consoleLog,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    try {
      state.runWithModelFallbackMock.mockImplementationOnce(
        async (params: FallbackRunnerParams) => ({
          result: await params.run("openai", "gpt-5.5", initialFallbackAttemptOptions(params)),
          provider: "openai",
          model: "gpt-5.5",
          attempts: [{ provider: "anthropic", model: "claude", error: "rate limit" }],
        }),
      );
      const context = {
        backend: "codex-app-server",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "compaction-1",
      };
      mockCompaction(context, context);

      const result = await executeTestTurn({ opts: { onBlockReply } });

      expect(result.kind).toBe("success");
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(consoleLog.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
        "codex app-server auto-compaction succeeded for openai/gpt-5.5; refreshed session context",
      );
    } finally {
      loggingState.rawConsole = null;
      setLoggerOverride(null);
      resetLogger();
    }
  });

  it("carries committed compaction into a later CLI fallback failure", async () => {
    state.isCliProviderMock.mockImplementation((provider: unknown) => provider === "claude-cli");
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onAutoCompactionSucceeded?.(1);
      throw new Error("retry transcript preparation failed");
    });
    state.runCliAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onExecutionPhase?.({ phase: "process_spawned" });
      return {
        payloads: [{ text: formatBillingErrorMessage(), isError: true }],
        meta: { error: { kind: "billing", message: "billing unavailable" } },
      };
    });
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => {
      await params
        .run("openai", "gpt-5.5", initialFallbackAttemptOptions(params))
        .catch(() => undefined);
      return {
        outcome: "exhausted",
        result: await params.run(
          "claude-cli",
          "claude-sonnet-4-6",
          initialFallbackAttemptOptions(params),
        ),
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        attempts: [
          {
            provider: "openai",
            model: "gpt-5.5",
            error: "retry transcript preparation failed",
            reason: "unknown",
          },
          {
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            error: "billing unavailable",
            reason: "billing",
          },
        ],
      };
    });

    const result = await executeTestTurn();

    expect(result).toMatchObject({
      kind: "success",
      autoCompactionCount: 1,
      postCompactionModelFailure: true,
    });
  });

  it("does not create the failure fact before the compacted retry reaches the model", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onAutoCompactionSucceeded?.(1);
      throw new Error("retry transcript preparation failed");
    });

    const result = await executeTestTurn();

    expect(result).toMatchObject({ kind: "final" });
    expect(result.postCompactionModelFailure).toBeUndefined();
  });

  it("keeps session settlement failures out of the model failure fact", async () => {
    const settleSessionOverride = vi
      .spyOn(autoFallback, "clearRecoveredAutoFallbackPrimaryProbeSelection")
      .mockRejectedValueOnce(new Error("session override settlement failed"));
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      params.onAutoCompactionSucceeded?.(1);
      params.onExecutionPhase?.({ phase: "model_call_started" });
      return { payloads: [{ text: "recovered" }], meta: {} };
    });

    try {
      const result = await executeTestTurn();

      expect(result).toMatchObject({ kind: "final" });
      expect(result.postCompactionModelFailure).toBeUndefined();
    } finally {
      settleSessionOverride.mockRestore();
    }
  });

  it("delivers compaction hook messages alongside notifyUser notices (#90185)", async () => {
    const onBlockReply = vi.fn();
    mockCompaction({ messages: ["Hook before"] }, { messages: ["Hook after"] });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onBlockReply).toHaveBeenCalledTimes(4);
    expectNotices(
      onBlockReply,
      ["Hook before", "🧹 Compacting context...", "Hook after", "🧹 Compaction complete"],
      true,
    );
  });

  it("fires both notifyUser notices alongside onCompactionStart / onCompactionEnd callbacks (#87107)", async () => {
    const onBlockReply = vi.fn();
    const onCompactionStart = vi.fn();
    const onCompactionEnd = vi.fn();
    mockCompaction();

    const result = await executeTestTurn(
      {
        followupRun: createNotifyUserRun(),
        opts: { onBlockReply, onCompactionStart, onCompactionEnd },
      },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    // Internal callbacks (Control UI etc.) and the user-channel notifyUser
    // notices are independent audiences; both must fire when opted in.
    expect(onCompactionStart).toHaveBeenCalledTimes(1);
    expect(onCompactionEnd).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expectNotices(onBlockReply, ["🧹 Compacting context...", "🧹 Compaction complete"]);
  });

  it("emits an incomplete compaction notice when compaction ends without completing", async () => {
    const onBlockReply = vi.fn();
    const onCompactionEnd = vi.fn();
    mockCompaction({}, { completed: false });

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun(), opts: { onBlockReply, onCompactionEnd } },
      { commandBody: "hello" },
    );

    expect(result.kind).toBe("success");
    expect(onCompactionEnd).toHaveBeenCalledWith({ completed: false });
    expectNotices(onBlockReply, ["🧹 Compacting context...", "🧹 Compaction incomplete"]);
  });

  it("uses the compaction notice fallback when no block-reply dispatcher is wired", async () => {
    const onCompactionNoticePayload = vi.fn();
    mockCompaction();

    const result = await executeTestTurn(
      { followupRun: createNotifyUserRun() },
      { commandBody: "hello", onCompactionNoticePayload },
    );

    expect(result.kind).toBe("success");
    expect(onCompactionNoticePayload).toHaveBeenCalledTimes(2);
    expectNotices(
      onCompactionNoticePayload,
      ["🧹 Compacting context...", "🧹 Compaction complete"],
      true,
    );
  });
});
