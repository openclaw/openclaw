import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createCliJsonlStreamingParser } from "../../agents/cli-output-stream.js";
import type { GetReplyOptions } from "../types.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  runInitialFallbackAttempt,
  createMinimalRunAgentTurnParams,
} from "./agent-runner-execution.test-support.js";
import type {
  FallbackRunnerParams,
  EmbeddedAgentParams,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();

function createCliRun(provider: string, model: string) {
  state.isCliProviderMock.mockReturnValue(true);
  state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
    result: await runInitialFallbackAttempt(params, provider, model),
    provider,
    model,
    attempts: [],
  }));
  const followupRun = createFollowupRun();
  followupRun.run.provider = provider;
  followupRun.run.model = model;
  return followupRun;
}

function executeCliTurn(
  followupRun: ReturnType<typeof createFollowupRun>,
  opts: GetReplyOptions,
  typingSignals = createMockTypingSignaler(),
) {
  return executeAgentTurn({
    commandBody: "hi",
    followupRun,
    sessionCtx: { Provider: "telegram", MessageSid: "msg" },
    opts,
    typingSignals,
    ...createAgentTurnExecutionDefaults(),
  });
}

describe("executeAgentTurn: CLI progress bridging", () => {
  it("serializes and drains bridged CLI assistant previews before completing (#76869)", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(false);
        const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
          "../../infra/agent-events.js",
        );
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "assistant",
          data: { text: "Hello", delta: "Hello" },
        });
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "assistant",
          data: { text: "Hello world", delta: " world" },
        });
        return { payloads: [{ text: "Hello world" }], meta: {} };
      },
    );

    let firstPreviewStarted: (() => void) | undefined;
    let releaseFirstPreview: (() => void) | undefined;
    const firstPreviewPromise = new Promise<void>((resolve) => {
      firstPreviewStarted = resolve;
    });
    const previewOrder: string[] = [];
    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (payload) => {
        previewOrder.push(payload.text ?? "");
        if (payload.text === "Hello") {
          firstPreviewStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirstPreview = resolve;
          });
          previewOrder.push("Hello released");
        }
      },
    );

    const runPromise = executeCliTurn(followupRun, { onPartialReply });

    await firstPreviewPromise;
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(previewOrder).toEqual(["Hello"]);

    releaseFirstPreview?.();
    await runPromise;

    expect(previewOrder).toEqual(["Hello", "Hello released", "Hello world"]);
  });

  it("bridges CLI tool agent events into onToolStart for live preview", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(false);
        const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
          "../../infra/agent-events.js",
        );
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "start",
            name: "Bash",
            toolCallId: "toolu_01ABCD",
            args: { command: "ls -la" },
          },
        });
        realAgentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "tool",
          data: {
            phase: "result",
            name: "Bash",
            toolCallId: "toolu_01ABCD",
            isError: false,
          },
        });
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );

    const onToolStart = vi.fn<NonNullable<GetReplyOptions["onToolStart"]>>(async () => undefined);

    await executeCliTurn(followupRun, { onToolStart });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onToolStart).toHaveBeenCalledTimes(1);
    const call = onToolStart.mock.calls[0]?.[0];
    expect(call?.name).toBe("Bash");
    expect(call?.phase).toBe("start");
    expect(call?.args).toEqual({ command: "ls -la" });
  });

  it("starts CLI assistant progress before a later tool while typing is slow", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const agentEvents = await import("../../infra/agent-events.js");
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "answer before tool", delta: "answer before tool" },
      });
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "answer before tool 2", delta: " 2" },
      });
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: "Bash",
          toolCallId: "toolu_order",
          args: { command: "echo hi" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    let releaseTyping: (() => void) | undefined;
    const typingPending = new Promise<void>((resolve) => {
      releaseTyping = resolve;
    });
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalTextDelta).mockReturnValue(typingPending);
    const callbackOrder: string[] = [];
    const toolStarted = createDeferred();
    const runPromise = executeCliTurn(
      followupRun,
      {
        preserveProgressCallbackStartOrder: true,
        onPartialReply: (payload) => {
          callbackOrder.push(`partial:${payload.text}`);
        },
        onToolStart: () => {
          callbackOrder.push("tool");
          toolStarted.resolve();
        },
      },
      typingSignals,
    );
    onTestFinished(async () => {
      releaseTyping?.();
      await runPromise;
    });

    try {
      await Promise.race([toolStarted.promise, runPromise]);
      expect(callbackOrder).toEqual([
        "partial:answer before tool",
        "partial:answer before tool 2",
        "tool",
      ]);
    } finally {
      releaseTyping?.();
      await runPromise;
    }
  });

  it("starts CLI tool progress before later assistant text while typing is slow", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const agentEvents = await import("../../infra/agent-events.js");
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: "Bash",
          toolCallId: "toolu_inverse_order",
          args: { command: "echo hi" },
        },
      });
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: {
          phase: "update",
          name: "Bash",
          toolCallId: "toolu_inverse_order",
          args: { command: "echo hi" },
        },
      });
      agentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "answer after tool", delta: "answer after tool" },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    let releaseTyping: (() => void) | undefined;
    const typingPending = new Promise<void>((resolve) => {
      releaseTyping = resolve;
    });
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalToolStart).mockReturnValue(typingPending);
    const callbackOrder: string[] = [];
    const partialReplyStarted = createDeferred();
    const runPromise = executeCliTurn(
      followupRun,
      {
        preserveProgressCallbackStartOrder: true,
        onPartialReply: (payload) => {
          callbackOrder.push(`partial:${payload.text}`);
          partialReplyStarted.resolve();
        },
        onToolStart: (payload) => {
          callbackOrder.push(`tool:${payload.phase}`);
        },
      },
      typingSignals,
    );
    onTestFinished(async () => {
      releaseTyping?.();
      await runPromise;
    });

    try {
      await Promise.race([partialReplyStarted.promise, runPromise]);
      expect(callbackOrder).toEqual(["tool:start", "tool:update", "partial:answer after tool"]);
    } finally {
      releaseTyping?.();
      await runPromise;
    }
  });

  it("bridges CLI preambles for progress headlines when commentary is disabled", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        expect(params.emitCommentaryText).toBe(true);
        const agentEvents = await import("../../infra/agent-events.js");
        // Inter-tool commentary surfaces as a stream:"item", kind:"preamble" agent event.
        agentEvents.emitAgentEvent({
          runId: params.runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-1",
            progressText: "Let me check the files.",
          },
        });
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );

    const onItemEvent = vi.fn<NonNullable<GetReplyOptions["onItemEvent"]>>(async () => undefined);

    await executeCliTurn(followupRun, {
      onItemEvent,
      commentaryProgressEnabled: false,
      progressPreambleEnabled: true,
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onItemEvent).toHaveBeenCalledTimes(1);
    const call = onItemEvent.mock.calls[0]?.[0];
    expect(call?.kind).toBe("preamble");
    expect(call?.progressText).toBe("Let me check the files.");
    expect(call?.itemId).toBe("commentary-1");
  });

  it("does not emit CLI preambles when both progress lanes are disabled", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    state.runCliAgentMock.mockImplementationOnce(
      async (params: { runId: string; emitCommentaryText?: boolean }) => {
        // With no commentary lane or headline consumer, pre-tool text stays in
        // the assistant stream instead of being split into progress events.
        expect(params.emitCommentaryText).toBe(false);
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );

    const onItemEvent = vi.fn<NonNullable<GetReplyOptions["onItemEvent"]>>();

    await executeCliTurn(followupRun, {
      onItemEvent,
      commentaryProgressEnabled: false,
      progressPreambleEnabled: false,
    });

    expect(state.runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(onItemEvent).not.toHaveBeenCalled();
  });

  it("does not bridge CLI tool deltas when silentExpected is set", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "tool",
        data: {
          phase: "start",
          name: "Bash",
          toolCallId: "toolu_silent",
          args: { command: "echo silent" },
        },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onToolStart = vi.fn<NonNullable<GetReplyOptions["onToolStart"]>>(async () => undefined);
    followupRun.run.silentExpected = true;

    await executeCliTurn(followupRun, { onToolStart });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onToolStart).not.toHaveBeenCalled();
  });

  it("does not bridge CLI assistant deltas when silentExpected is set (#76869)", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "secret heartbeat output", delta: "secret heartbeat output" },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "assistant",
        data: { text: "NO_REPLY do not preview", delta: " do not preview" },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (_payload) => undefined,
    );
    followupRun.run.silentExpected = true;

    await executeCliTurn(followupRun, { onPartialReply });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("bridges CLI thinking agent events into onReasoningStream with the reasoning opt-in gate", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-7");
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "Thinking", isReasoningSnapshot: true },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking", delta: "", isReasoningSnapshot: true },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "Thinking about it", delta: " about it", isReasoningSnapshot: true },
      });
      return { payloads: [{ text: "Thinking about it" }], meta: {} };
    });

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );

    await executeCliTurn(followupRun, { onReasoningStream });

    expect(onReasoningStream.mock.calls.map((call) => call[0])).toEqual([
      {
        text: "Thinking",
        isReasoningSnapshot: true,
        requiresReasoningProgressOptIn: true,
      },
      {
        text: "Thinking about it",
        isReasoningSnapshot: true,
        requiresReasoningProgressOptIn: true,
      },
    ]);
  });

  it("bridges tagged Claude CLI reasoning separately from its visible answer", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-7");
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      const parser = createCliJsonlStreamingParser({
        backend: {
          command: "local-cli",
          output: "jsonl",
          jsonlDialect: "claude-stream-json",
        },
        providerId: "claude-cli",
        onAssistantDelta: (delta) =>
          realAgentEvents.emitAgentEvent({
            runId: params.runId,
            stream: "assistant",
            data: delta,
          }),
        onThinkingDelta: (delta) =>
          realAgentEvents.emitAgentEvent({
            runId: params.runId,
            stream: "thinking",
            data: delta,
          }),
      });
      parser.push(
        [
          JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: {
                type: "text_delta",
                text: "<thinking>Private analysis.</thinking>Visible answer.",
              },
            },
          }),
          JSON.stringify({
            type: "result",
            result: "<thinking>Private analysis.</thinking>Visible answer.",
          }),
          "",
        ].join("\n"),
      );
      parser.finish();
      return { payloads: [{ text: parser.getOutput()?.text ?? "" }], meta: {} };
    });

    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async () => undefined,
    );
    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async () => undefined,
    );

    await executeCliTurn(followupRun, { onPartialReply, onReasoningStream });

    expect(onReasoningStream.mock.calls.map(([payload]) => payload.text)).toEqual([
      "Private analysis.",
    ]);
    expect(onPartialReply.mock.calls.map(([payload]) => payload.text)).toEqual(["Visible answer."]);
  });

  it("does not bridge CLI thinking events to onReasoningStream when silentExpected is set", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-7");
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const realAgentEvents = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "heartbeat scratch text", delta: "heartbeat scratch text" },
      });
      realAgentEvents.emitAgentEvent({
        runId: params.runId,
        stream: "thinking",
        data: { text: "NO_REPLY do not preview reasoning", delta: " do not preview reasoning" },
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );
    followupRun.run.silentExpected = true;

    await executeCliTurn(followupRun, { onReasoningStream });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    expect(onReasoningStream).not.toHaveBeenCalled();
  });

  it("preserves embedded reasoning stream opt-in markers", async () => {
    state.runEmbeddedAgentMock.mockImplementationOnce(async (params: EmbeddedAgentParams) => {
      await params.onReasoningStream?.({ text: "stream thought" });
      await params.onReasoningStream?.({
        text: "ambient thought",
        requiresReasoningProgressOptIn: true,
      });
      return { payloads: [{ text: "final" }], meta: {} };
    });

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );

    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        opts: { onReasoningStream },
      }),
    );

    expect(
      onReasoningStream.mock.calls.map(([payload]) => ({
        text: payload.text,
        requiresReasoningProgressOptIn: payload.requiresReasoningProgressOptIn,
      })),
    ).toEqual([
      { text: "stream thought", requiresReasoningProgressOptIn: undefined },
      { text: "ambient thought", requiresReasoningProgressOptIn: true },
    ]);
  });
});
