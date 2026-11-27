import { assert, beforeEach, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { RunCliAgentParams } from "../../agents/cli-runner/types.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { BlockReplyContext, GetReplyOptions, ReplyPayload } from "../types.js";
import { setupCliExecutionTest } from "./agent-runner-execution-cli.test-support.js";
import { loadActualRunCliAgentForTest } from "./agent-runner-execution.test-support.js";

const {
  state,
  execute,
  mockEvents: mockCliEvents,
} = await setupCliExecutionTest("claude-opus-4-6");

const scriptedCliProgram = String.raw`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  if (!input.trim()) process.exit(2);
  const textDelta = (text) => ({ type: "content_block_delta", delta: { type: "text_delta", text } });
  const events = [
    { type: "init", session_id: "scripted-commentary" },
    ...[
      textDelta("The subprocess findings are durable."),
      { type: "content_block_start", index: 1,
        content_block: { type: "tool_use", id: "tool-scripted", name: "Read", input: {} } },
      textDelta("Subprocess final answer."),
      { type: "message_stop" },
    ].map((event) => ({ type: "stream_event", event })),
    { type: "result", session_id: "scripted-commentary", result: "Subprocess final answer." },
  ];
  process.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
});
`;

beforeEach(() => {
  const backend = {
    id: "claude-cli",
    modelProvider: "anthropic",
    pluginId: "anthropic",
    bundleMcp: false,
    contextEngineHostCapabilities: ["thread-bootstrap-projection"] as const,
    config: {
      command: process.execPath,
      args: ["-e", scriptedCliProgram],
      input: "stdin" as const,
      output: "jsonl" as const,
      jsonlDialect: "claude-stream-json" as const,
      sessionMode: "none" as const,
      systemPromptWhen: "never" as const,
    },
  };
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupCliBackend: ({ backend: id }) =>
      id === backend.id ? { pluginId: backend.pluginId, backend } : undefined,
    resolveRuntimeCliBackends: () => [backend],
  });
});

function executeCliTurn(opts: GetReplyOptions, blockStreamingEnabled: boolean) {
  return execute(
    opts,
    {
      agentId: "agent",
      sessionKey: "agent:agent:main",
      skillsSnapshot: { prompt: "", skills: [], version: 0 },
      timeoutMs: 10_000,
    },
    { commandBody: "hi", blockStreamingEnabled, sessionKey: "agent:agent:main" },
  );
}

function useRawBlockDelivery() {
  state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
    (params: { onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> }) => params.onBlockReply,
  );
}

type Callback<K extends keyof GetReplyOptions> = NonNullable<GetReplyOptions[K]>;
function replySpies() {
  return {
    onBlockReply: vi.fn<Callback<"onBlockReply">>(async () => undefined),
    onPreparedBlockReply: vi.fn<Callback<"onPreparedBlockReply">>(async () => undefined),
    onPartialReply: vi.fn<Callback<"onPartialReply">>(async () => undefined),
    onItemEvent: vi.fn<Callback<"onItemEvent">>(async () => undefined),
  };
}

function mockCommentary(source: string, itemId: string, finalText: string) {
  mockCliEvents(
    [["item", { kind: "preamble", itemId, progressText: source }]],
    [{ text: finalText }],
    {},
    (params) => {
      expect(params.emitCommentaryText).toBe(true);
    },
  );
}

it("delivers commentary from a real JSONL CLI subprocess", async () => {
  useRawBlockDelivery();
  state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) =>
    (await loadActualRunCliAgentForTest())(params),
  );
  const { onBlockReply } = replySpies();
  const result = await executeCliTurn({ onBlockReply }, true);

  expect(state.runCliAgentMock.mock.calls[0]?.[0]).toMatchObject({ emitCommentaryText: true });
  const resolveContextEngineHost = state.runEmbeddedAgentEntryMock.mock.calls[0]?.[0]?.harness
    ?.resolveContextEngineHost as
    | ((provider: string, model: string) => ContextEngineHostSupport | undefined)
    | undefined;
  expect(resolveContextEngineHost?.("claude-cli", "claude-opus-4-6")).toEqual({
    id: "cli:claude-cli",
    label: 'CLI backend "claude-cli"',
    capabilities: ["thread-bootstrap-projection"],
  });
  assert(result.kind === "success");
  expect(result.runResult.payloads).toEqual([{ text: "Subprocess final answer." }]);
  expect(onBlockReply).toHaveBeenCalledOnce();
  expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({
    text: "The subprocess findings are durable.",
  });
});

it.each([
  {
    source: "[[reply_to:target]] [[audio_as_voice]] The durable findings live here.",
    expected: {
      text: "The durable findings live here.",
      replyToId: "target",
      replyToTag: true,
      audioAsVoice: true,
    },
  },
  {
    source: "Literal `[[reply_to:target]] [[audio_as_voice]]` findings.",
    expected: {
      text: "Literal `[[reply_to:target]] [[audio_as_voice]]` findings.",
      replyToId: undefined,
      audioAsVoice: undefined,
    },
  },
])(
  "prepares completed CLI commentary for block streaming: $source",
  async ({ source, expected }) => {
    useRawBlockDelivery();
    mockCommentary(source, "commentary-durable-1", "Short final wrap-up.");

    const { onBlockReply, onPreparedBlockReply, onItemEvent } = replySpies();
    const result = await executeCliTurn(
      {
        onBlockReply,
        onPreparedBlockReply,
        onItemEvent,
        commentaryProgressEnabled: false,
        progressPreambleEnabled: true,
      },
      true,
    );

    await vi.waitFor(() => {
      expect(onPreparedBlockReply).toHaveBeenCalledOnce();
      expect(onPreparedBlockReply.mock.calls[0]?.[0].payload).toMatchObject(expected);
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(onItemEvent).toHaveBeenCalledExactlyOnceWith({
        itemId: "commentary-durable-1",
        kind: "preamble",
        progressText: source,
        suppressDurableProgress: true,
      });
    });
    assert(result.kind === "success");
    expect(result.runResult.payloads).toEqual([{ text: "Short final wrap-up." }]);
  },
);

it.each(["raw", "prepared", "both"] as const)(
  "forwards native CLI input through the %s sink without model normalization",
  async (mode) => {
    useRawBlockDelivery();
    const button = {
      label: "Blue",
      action: { type: "question", questionId: "question-1", optionValue: "Blue" },
    } as const;
    const nativePayload: ReplyPayload = setReplyPayloadMetadata(
      {
        text: "Which color?",
        presentation: { blocks: [{ type: "buttons", buttons: [button] }] },
      },
      { deliverDespiteSourceReplySuppression: true },
    );
    const nativeContext: BlockReplyContext = {
      assistantMessageIndex: 11,
      deliveryIntentId: "native-question-1",
    };
    const { onBlockReply, onPreparedBlockReply, onPartialReply } = replySpies();
    state.runCliAgentMock.mockImplementationOnce(async (params: RunCliAgentParams) => {
      if (mode !== "prepared") {
        expect(params.onBlockReply).toBe(onBlockReply);
      }
      await params.onBlockReply?.(nativePayload, nativeContext);
      await params.onPartialReply?.({ text: "Fallback question" });
      return { payloads: [{ text: "Answered." }], meta: {} };
    });

    await executeCliTurn(
      {
        ...(mode !== "prepared" ? { onBlockReply } : {}),
        ...(mode !== "raw" ? { onPreparedBlockReply } : {}),
        onPartialReply,
      },
      false,
    );

    if (mode === "prepared") {
      expect(onBlockReply).not.toHaveBeenCalled();
      expect(onPreparedBlockReply).toHaveBeenCalledOnce();
      const [plan, context] = onPreparedBlockReply.mock.calls[0]!;
      expect(plan.payload).toMatchObject(nativePayload);
      expect(plan.payload.replyToId).toBeUndefined();
      expect(getReplyPayloadMetadata(plan.payload)?.deliverDespiteSourceReplySuppression).toBe(
        true,
      );
      expect(context).toBe(nativeContext);
    } else {
      expect(onBlockReply).toHaveBeenCalledExactlyOnceWith(nativePayload, nativeContext);
      expect(onPreparedBlockReply).not.toHaveBeenCalled();
    }
    expect(onPartialReply).toHaveBeenCalledWith({ text: "Fallback question" });
  },
);

it.each(
  [false, true].flatMap((completed) =>
    ["NO_REPLY", "An ordinary caption."].map((text) => ({ text, completed })),
  ),
)(
  "keeps prepared CLI payload facts through normalization (completed=$completed): $text",
  async ({ text, completed }) => {
    const { createBlockReplyDeliveryHandler } =
      await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
    const normalizeMediaPaths = vi.fn(async (payload: ReplyPayload) => {
      expect(payload.mediaUrls).toEqual(["https://example.invalid/attachment.txt"]);
      return copyReplyPayloadMetadata(payload, {
        ...payload,
        text: "Attachment preparation failed.",
        mediaUrl: undefined,
        mediaUrls: undefined,
      });
    });
    state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(
      (params: Parameters<typeof createBlockReplyDeliveryHandler>[0]) =>
        createBlockReplyDeliveryHandler({ ...params, normalizeMediaPaths }),
    );
    state.runCliAgentMock.mockImplementationOnce(async (params: { runId: string }) => {
      const { emitAgentEvent } = await import("../../infra/agent-events.js");
      emitAgentEvent({
        runId: params.runId,
        stream: completed ? "assistant" : "item",
        data: completed
          ? {
              completedText: `${text}\nMEDIA:https://example.invalid/attachment.txt`,
              assistantMessageIndex: 0,
            }
          : {
              kind: "preamble",
              itemId: "commentary-silence",
              progressText: `${text}\nMEDIA:https://example.invalid/attachment.txt`,
            },
      });
      return { payloads: [{ text: "Final answer." }], meta: {} };
    });
    const { onPreparedBlockReply } = replySpies();

    await executeCliTurn({ onPreparedBlockReply }, !completed);

    expect(normalizeMediaPaths).toHaveBeenCalledOnce();
    expect(onPreparedBlockReply).toHaveBeenCalledOnce();
    expect(onPreparedBlockReply.mock.calls[0]?.[0].payload.text).toBe(
      "Attachment preparation failed.",
    );
  },
);

it("delivers commentary payloads without block streaming", async () => {
  useRawBlockDelivery();
  mockCommentary("A durable commentary update.", "commentary-payload-1", "Final answer.");

  const { onBlockReply } = replySpies();
  const result = await executeCliTurn({ onBlockReply, commentaryPayloadsEnabled: true }, false);

  await vi.waitFor(() => {
    expect(onBlockReply).toHaveBeenCalledOnce();
    expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({
      text: "A durable commentary update.",
      isCommentary: true,
    });
  });
  assert(result.kind === "success");
  expect(result.runResult.payloads).toEqual([{ text: "Final answer." }]);
});
