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
  createCliFollowupRun as createCliRun,
} from "./agent-runner-execution.test-support.js";

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

function replySpies() {
  return {
    onItemEvent: vi.fn<NonNullable<GetReplyOptions["onItemEvent"]>>(async () => undefined),
    onToolStart: vi.fn<NonNullable<GetReplyOptions["onToolStart"]>>(async () => undefined),
    onPartialReply: vi.fn<NonNullable<GetReplyOptions["onPartialReply"]>>(async () => undefined),
    onReasoningStream: vi.fn<NonNullable<GetReplyOptions["onReasoningStream"]>>(
      async () => undefined,
    ),
  };
}

function releaseTypingAfterRun(typing: { resolve: () => void }, run: Promise<unknown>) {
  const finish = async () => {
    typing.resolve();
    await run;
  };
  onTestFinished(finish);
  return finish;
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

  it.each(["assistant", "tool"] as const)(
    "starts %s progress first while typing is slow",
    async (first) => {
      const assistantFirst = first === "assistant";
      const event = (text: string, delta = text): CliEvent => ["assistant", { text, delta }];
      const tool = (phase: string) =>
        toolEvent(phase, "toolu_order", { args: { command: "echo hi" } });
      mockCliEvents(
        assistantFirst
          ? [event("answer before tool"), event("answer before tool 2", " 2"), tool("start")]
          : [tool("start"), tool("update"), tool("result"), event("answer after tool")],
      );
      const typing = createDeferred();
      const typingSignals = createMockTypingSignaler();
      vi.mocked(
        assistantFirst ? typingSignals.signalTextDelta : typingSignals.signalToolStart,
      ).mockReturnValue(typing.promise);
      const callbackOrder: string[] = [];
      const toolCalls: unknown[] = [];
      const expectedOrder = assistantFirst
        ? ["partial:answer before tool", "partial:answer before tool 2", "tool"]
        : ["tool:start", "tool:update", "partial:answer after tool"];
      const lastStarted = createDeferred();
      const runPromise = executeCliTurn(
        createCliRun("claude-cli", "claude-opus-4-6"),
        {
          preserveProgressCallbackStartOrder: true,
          onPartialReply: (payload) => {
            callbackOrder.push(`partial:${payload.text}`);
            if (!assistantFirst) {
              lastStarted.resolve();
            }
          },
          onToolStart: (payload) => {
            toolCalls.push([payload.name, payload.args]);
            callbackOrder.push(assistantFirst ? "tool" : `tool:${payload.phase}`);
            if (assistantFirst) {
              lastStarted.resolve();
            }
          },
        },
        typingSignals,
      );
      const finish = releaseTypingAfterRun(typing, runPromise);

      try {
        await Promise.race([lastStarted.promise, runPromise]);
        expect(callbackOrder).toEqual(expectedOrder);
      } finally {
        await finish();
      }
      expect(callbackOrder).toEqual(expectedOrder);
      expect(toolCalls).toEqual(
        Array.from({ length: assistantFirst ? 1 : 2 }, () => ["Bash", { command: "echo hi" }]),
      );
    },
  );

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

    const { onItemEvent } = replySpies();

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

  it.each(["tool", "assistant", "thinking"] as const)(
    "does not bridge CLI %s deltas when silentExpected is set (#76869)",
    async (stream) => {
      const followupRun = createCliRun("claude-cli", "claude-opus-4-7");
      followupRun.run.silentExpected = true;
      mockCliEvents(
        stream === "tool"
          ? [toolEvent("start", "toolu_silent", { args: { command: "echo silent" } })]
          : [
              [stream, { text: "secret heartbeat output", delta: "secret heartbeat output" }],
              [stream, { text: "NO_REPLY do not preview", delta: " do not preview" }],
            ],
      );
      const { onToolStart, onPartialReply, onReasoningStream } = replySpies();
      await executeCliTurn(followupRun, { onToolStart, onPartialReply, onReasoningStream });
      await nextImmediate();
      expect(onToolStart).not.toHaveBeenCalled();
      expect(onPartialReply).not.toHaveBeenCalled();
      expect(onReasoningStream).not.toHaveBeenCalled();
    },
  );

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

    const { onReasoningStream } = replySpies();

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

    const { onPartialReply, onReasoningStream } = replySpies();

    await executeCliTurn(followupRun, { onPartialReply, onReasoningStream });

    expect(onReasoningStream.mock.calls.map(([payload]) => payload)).toEqual([
      {
        text: "Private analysis.",
        isReasoningSnapshot: true,
        requiresReasoningProgressOptIn: true,
      },
    ]);
    expect(onPartialReply.mock.calls.map(([payload]) => payload.text)).toEqual(["Visible answer."]);
  });
});
