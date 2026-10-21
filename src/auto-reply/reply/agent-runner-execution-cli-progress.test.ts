import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createCliJsonlStreamingParser } from "../../agents/cli-output-stream.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import type { GetReplyOptions } from "../types.js";
import {
  createAgentTurnExecutionDefaults,
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createMockTypingSignaler,
  createFollowupRun,
  runInitialFallbackAttempt,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const executeAgentTurn = await getExecuteAgentTurnForTest();
type CliEvent = [AgentEventPayload["stream"], AgentEventPayload["data"]];

function mockCliEvents(events: CliEvent[], text = "final", emitCommentaryText?: boolean) {
  state.runCliAgentMock.mockImplementationOnce(
    async (params: { runId: string; emitCommentaryText?: boolean }) => {
      if (emitCommentaryText !== undefined) {
        expect(params.emitCommentaryText).toBe(emitCommentaryText);
      }
      const { emitAgentEvent } = await vi.importActual<
        typeof import("../../infra/agent-events.js")
      >("../../infra/agent-events.js");
      for (const [stream, data] of events) {
        emitAgentEvent({ runId: params.runId, stream, data });
      }
      return { payloads: [{ text }], meta: {} };
    },
  );
}

const nextImmediate = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

function toolEvent(phase: string, toolCallId: string, extra: Record<string, unknown>) {
  return ["tool", { phase, name: "Bash", toolCallId, ...extra }] satisfies CliEvent;
}

function releaseTypingAfterRun(typing: { resolve: () => void }, run: Promise<unknown>) {
  const finish = async () => {
    typing.resolve();
    await run;
  };
  onTestFinished(finish);
  return finish;
}

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
    mockCliEvents(
      [
        ["assistant", { text: "Hello", delta: "Hello" }],
        ["assistant", { text: "Hello world", delta: " world" }],
      ],
      "Hello world",
      false,
    );

    const firstPreview = createDeferred();
    const releasePreview = createDeferred();
    const previewOrder: string[] = [];
    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (payload) => {
        previewOrder.push(payload.text ?? "");
        if (payload.text === "Hello") {
          firstPreview.resolve();
          await releasePreview.promise;
          previewOrder.push("Hello released");
        }
      },
    );

    const runPromise = executeCliTurn(followupRun, { onPartialReply });

    await firstPreview.promise;
    await nextImmediate();
    expect(previewOrder).toEqual(["Hello"]);

    releasePreview.resolve();
    await runPromise;

    expect(previewOrder).toEqual(["Hello", "Hello released", "Hello world"]);
  });

  it("bridges CLI tool agent events into onToolStart for live preview", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    mockCliEvents(
      [
        toolEvent("start", "toolu_01ABCD", { args: { command: "ls -la" } }),
        toolEvent("result", "toolu_01ABCD", { isError: false }),
      ],
      "done",
      false,
    );

    const onToolStart = vi.fn<NonNullable<GetReplyOptions["onToolStart"]>>(async () => undefined);

    await executeCliTurn(followupRun, { onToolStart });
    await nextImmediate();

    expect(onToolStart).toHaveBeenCalledTimes(1);
    const call = onToolStart.mock.calls[0]?.[0];
    expect([call?.name, call?.phase, call?.args]).toEqual(["Bash", "start", { command: "ls -la" }]);
  });

  it("starts CLI assistant progress before a later tool while typing is slow", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    mockCliEvents([
      ["assistant", { text: "answer before tool", delta: "answer before tool" }],
      ["assistant", { text: "answer before tool 2", delta: " 2" }],
      toolEvent("start", "toolu_order", { args: { command: "echo hi" } }),
    ]);

    const typing = createDeferred();
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalTextDelta).mockReturnValue(typing.promise);
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
    const finish = releaseTypingAfterRun(typing, runPromise);

    try {
      await Promise.race([toolStarted.promise, runPromise]);
      expect(callbackOrder).toEqual([
        "partial:answer before tool",
        "partial:answer before tool 2",
        "tool",
      ]);
    } finally {
      await finish();
    }
  });

  it("starts CLI tool progress before later assistant text while typing is slow", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    mockCliEvents([
      toolEvent("start", "toolu_inverse_order", { args: { command: "echo hi" } }),
      toolEvent("update", "toolu_inverse_order", { args: { command: "echo hi" } }),
      ["assistant", { text: "answer after tool", delta: "answer after tool" }],
    ]);

    const typing = createDeferred();
    const typingSignals = createMockTypingSignaler();
    vi.mocked(typingSignals.signalToolStart).mockReturnValue(typing.promise);
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
    const finish = releaseTypingAfterRun(typing, runPromise);

    try {
      await Promise.race([partialReplyStarted.promise, runPromise]);
      expect(callbackOrder).toEqual(["tool:start", "tool:update", "partial:answer after tool"]);
    } finally {
      await finish();
    }
  });

  it("bridges CLI preambles for progress headlines when commentary is disabled", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    mockCliEvents(
      [
        [
          "item",
          {
            kind: "preamble",
            itemId: "commentary-1",
            progressText: "Let me check the files.",
          },
        ],
      ],
      "done",
      true,
    );

    const onItemEvent = vi.fn<NonNullable<GetReplyOptions["onItemEvent"]>>(async () => undefined);

    await executeCliTurn(followupRun, {
      onItemEvent,
      commentaryProgressEnabled: false,
      progressPreambleEnabled: true,
    });
    await nextImmediate();

    expect(onItemEvent).toHaveBeenCalledTimes(1);
    const call = onItemEvent.mock.calls[0]?.[0];
    expect([call?.kind, call?.progressText, call?.itemId]).toEqual([
      "preamble",
      "Let me check the files.",
      "commentary-1",
    ]);
  });

  it("does not bridge CLI tool deltas when silentExpected is set", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    mockCliEvents([toolEvent("start", "toolu_silent", { args: { command: "echo silent" } })]);

    const onToolStart = vi.fn<NonNullable<GetReplyOptions["onToolStart"]>>(async () => undefined);
    followupRun.run.silentExpected = true;

    await executeCliTurn(followupRun, { onToolStart });
    await nextImmediate();

    expect(onToolStart).not.toHaveBeenCalled();
  });

  it("does not bridge CLI assistant deltas when silentExpected is set (#76869)", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-6");
    mockCliEvents([
      ["assistant", { text: "secret heartbeat output", delta: "secret heartbeat output" }],
      ["assistant", { text: "NO_REPLY do not preview", delta: " do not preview" }],
    ]);

    const onPartialReply = vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(
      async (_payload) => undefined,
    );
    followupRun.run.silentExpected = true;

    await executeCliTurn(followupRun, { onPartialReply });
    await nextImmediate();

    expect(onPartialReply).not.toHaveBeenCalled();
  });

  it("bridges CLI thinking agent events into onReasoningStream with the reasoning opt-in gate", async () => {
    const followupRun = createCliRun("claude-cli", "claude-opus-4-7");
    mockCliEvents(
      [
        ["thinking", { text: "Thinking", delta: "Thinking", isReasoningSnapshot: true }],
        ["thinking", { text: "Thinking", delta: "", isReasoningSnapshot: true }],
        ["thinking", { text: "Thinking about it", delta: " about it", isReasoningSnapshot: true }],
      ],
      "Thinking about it",
    );

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
      const { emitAgentEvent } = await vi.importActual<
        typeof import("../../infra/agent-events.js")
      >("../../infra/agent-events.js");
      const { runId } = params;
      const text = "<thinking>Private analysis.</thinking>Visible answer.";
      const parser = createCliJsonlStreamingParser({
        backend: {
          command: "local-cli",
          output: "jsonl",
          jsonlDialect: "claude-stream-json",
        },
        providerId: "claude-cli",
        onAssistantDelta: (data) => emitAgentEvent({ runId, stream: "assistant", data }),
        onThinkingDelta: (data) => emitAgentEvent({ runId, stream: "thinking", data }),
      });
      parser.push(
        [
          JSON.stringify({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text },
            },
          }),
          JSON.stringify({ type: "result", result: text }),
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
    mockCliEvents([
      ["thinking", { text: "heartbeat scratch text", delta: "heartbeat scratch text" }],
      [
        "thinking",
        { text: "NO_REPLY do not preview reasoning", delta: " do not preview reasoning" },
      ],
    ]);

    const onReasoningStream = vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async (_payload) => undefined,
    );
    followupRun.run.silentExpected = true;

    await executeCliTurn(followupRun, { onReasoningStream });
    await nextImmediate();

    expect(onReasoningStream).not.toHaveBeenCalled();
  });
});
