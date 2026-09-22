import OpenAI from "openai";
import { expect } from "vitest";
import {
  buildAgentRunTerminalOutcome,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
} from "../agents/agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../agents/command/lifecycle.js";
import { recordAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import {
  emitAgentEvent,
  onAgentEvent,
  getAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";

export function parseSseDataLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

// SDK error handling aborts its fetch before [DONE]. Observe wire framing on
// its own request so SDK cancellation cannot destroy the capture.
export async function readRawChatCompletionStream(
  response: Response,
  expectedError?: { message: string; type: string },
): Promise<OpenAI.ChatCompletionChunk["choices"]> {
  expect(response.status).toBe(200);
  const data = parseSseDataLines(await response.text());
  const chunks = data
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as OpenAI.ChatCompletionChunk | { error: unknown });
  expect(chunks.filter((chunk) => "error" in chunk)).toEqual(
    expectedError ? [{ error: expectedError }] : [],
  );
  expect(data.at(-1)).toBe("[DONE]");
  return chunks.flatMap((chunk) => ("choices" in chunk ? chunk.choices : []));
}

type AssistantSnapshotCase = {
  name: string;
  events: Record<string, unknown>[];
  expected: string;
  resultTexts?: string[];
};

export function assistantSnapshotCases(leading: AssistantSnapshotCase): AssistantSnapshotCase[] {
  return [
    leading,
    {
      name: "identical snapshots from distinct assistant items",
      events: [
        { itemId: "answer-1", text: "Echo", delta: "Echo" },
        { itemId: "answer-2", text: "Echo", delta: "Echo" },
      ],
      expected: "Echo\n\nEcho",
      resultTexts: ["Echo", "Echo"],
    },
    {
      name: "replayed and growing snapshots across assistant items",
      events: [
        { itemId: "answer-1", text: "Echo", delta: "Echo" },
        { itemId: "answer-1", text: "Echo", delta: "Echo" },
        { itemId: "answer-2", text: "Echo", delta: "Echo" },
        { itemId: "answer-2", text: "Echo", delta: "Echo" },
        { itemId: "answer-2", text: "Echo!", delta: "!" },
      ],
      expected: "Echo\n\nEcho!",
    },
    {
      name: "repeated delta-only text within an assistant item",
      events: [
        { itemId: "answer-1", delta: "Echo" },
        { itemId: "answer-1", delta: "Echo" },
      ],
      expected: "EchoEcho",
    },
    {
      name: "split leading newlines followed by the matching item snapshot",
      events: [
        { itemId: "answer-1", text: "First." },
        { itemId: "answer-2", delta: "\n" },
        { itemId: "answer-2", delta: "\n" },
        { itemId: "answer-2", delta: "Se" },
        { itemId: "answer-2", delta: "cond." },
        { itemId: "answer-2", text: "\n\nSecond." },
      ],
      expected: "First.\n\nSecond.",
    },
    {
      name: "an empty new item followed by deltas and a matching snapshot",
      events: [
        { itemId: "answer-1", text: "First." },
        { itemId: "answer-2", delta: "" },
        { itemId: "answer-2", delta: "Second." },
        { itemId: "answer-2", text: "Second." },
      ],
      expected: "First.\n\nSecond.",
    },
    {
      name: "text beyond the live display cap",
      events: [
        { itemId: "answer-1", text: "x".repeat(500_001), delta: "x".repeat(500_001) },
        { itemId: "answer-2", text: "tail", delta: "tail" },
      ],
      expected: `${"x".repeat(500_001)}\n\ntail`,
    },
  ];
}

type IncompatibleReplacementCase = {
  name: string;
  replacementText: string;
  itemId?: string;
  recoveryItemId?: string;
  previousText?: string;
  replaceable?: boolean;
  recoveryText?: string;
  resultText?: string;
  noResultText?: boolean;
  terminalEcho?: boolean;
  tailDelta?: string;
};

export const incompatibleReplacementCases: IncompatibleReplacementCase[] = [
  { name: "rewritten", replacementText: "final answer" },
  { name: "shortened", replacementText: "dra" },
  { name: "rewritten then extended by a delta", replacementText: "other answer", tailDelta: "!" },
  { name: "cleared", replacementText: "" },
  {
    name: "replaced by a held provisional item",
    previousText: "Echo",
    replacementText: "Replacement",
    replaceable: true,
  },
  {
    name: "cleared by a held provisional item",
    previousText: "Echo",
    replacementText: "",
    replaceable: true,
  },
  {
    name: "cleared by an explicit empty final result",
    previousText: "Echo",
    replacementText: "Echo tail",
    resultText: "",
    replaceable: true,
  },
  {
    name: "cleared by held output without a text-bearing result",
    previousText: "Echo",
    replacementText: "",
    noResultText: true,
    replaceable: true,
  },
  {
    name: "replaced by a held item followed by its native terminal echo",
    previousText: "Echo",
    replacementText: "Replacement",
    replaceable: true,
    terminalEcho: true,
  },
  {
    name: "cleared on the same item before recovery reuses its ID",
    itemId: "failed-answer",
    replacementText: "",
    recoveryItemId: "failed-answer",
    recoveryText: "recovered answer",
  },
  {
    name: "cleared on the same item before a distinct recovery item",
    itemId: "failed-answer",
    replacementText: "",
    recoveryItemId: "recovery-answer",
    recoveryText: "recovered answer",
  },
];

type CompatibleReplacementCase = {
  name: string;
  previousDelta?: string;
  replacementDelta?: string;
  replacementText?: string;
  replaceable?: boolean;
  intermediateText?: string;
  resultText?: string;
  noResultText?: boolean;
  terminalEcho?: boolean;
  expectedDeltas: string;
};

export const compatibleReplacementCases: CompatibleReplacementCase[] = [
  {
    name: "a producer replacement snapshot without a delta",
    previousDelta: undefined,
    replacementDelta: undefined,
    expectedDeltas: "final answer",
  },
  {
    name: "a producer replacement snapshot with its own delta",
    previousDelta: undefined,
    replacementDelta: "final answer",
    expectedDeltas: "final answer",
  },
  {
    name: "an append-compatible replacement after streamed partial text",
    previousDelta: "final ",
    replacementDelta: "answer",
    expectedDeltas: "final answer",
  },
  {
    name: "a held append-compatible replacement",
    previousDelta: "Echo",
    replacementText: "Echo tail",
    replacementDelta: "",
    replaceable: true,
    expectedDeltas: "Echo tail",
  },
  {
    name: "a corrected held replacement",
    previousDelta: "Echo",
    intermediateText: "Replacement",
    replacementText: "Echo tail",
    replacementDelta: "",
    replaceable: true,
    expectedDeltas: "Echo tail",
  },
  {
    name: "a held draft recovered only by the authoritative final result",
    previousDelta: "Echo",
    replacementText: "Replacement",
    replacementDelta: "",
    resultText: "Echo tail",
    expectedDeltas: "Echo tail",
    replaceable: true,
  },
  {
    name: "held text without a text-bearing final payload",
    previousDelta: "Echo",
    replacementText: "Echo tail",
    replacementDelta: "",
    noResultText: true,
    expectedDeltas: "Echo tail",
    replaceable: true,
  },
  {
    name: "an initial held draft cleared by an explicit empty result",
    replacementText: "Draft",
    replacementDelta: "",
    resultText: "",
    expectedDeltas: "",
    replaceable: true,
  },
  {
    name: "a held replacement completed by its native terminal echo",
    previousDelta: "Echo",
    replacementText: "Echo tail",
    replacementDelta: "",
    expectedDeltas: "Echo tail",
    replaceable: true,
    terminalEcho: true,
  },
  {
    name: "an incompatible native echo recovered by the final result",
    previousDelta: "Echo",
    replacementText: "Replacement",
    replacementDelta: "",
    resultText: "Echo tail",
    expectedDeltas: "Echo tail",
    replaceable: true,
    terminalEcho: true,
  },
];

type BufferedReplacementCase = {
  name: string;
  replacement: { text?: string; delta?: string; replace?: boolean };
  finalText: string;
  expected: string;
};

export const bufferedReplacementCases: BufferedReplacementCase[] = [
  {
    name: "a completed replacement",
    replacement: { text: "final answer", delta: "", replace: true },
    finalText: "final answer",
    expected: "final answer",
  },
  {
    name: "an empty snapshot",
    replacement: { text: "", delta: "" },
    finalText: "",
    expected: "No response from OpenClaw.",
  },
  {
    name: "an empty replacement snapshot",
    replacement: { text: "", delta: "", replace: true },
    finalText: "",
    expected: "No response from OpenClaw.",
  },
  {
    name: "an empty delta without a snapshot",
    replacement: { delta: "" },
    finalText: "",
    expected: "coordination draft",
  },
];

export function emitIncompatibleAssistantReplacement(
  runId: string,
  scenario: IncompatibleReplacementCase,
  replacementDelta: "" | undefined,
) {
  const {
    previousText = "draft answer",
    replacementText,
    itemId,
    recoveryItemId,
    replaceable,
    recoveryText,
    terminalEcho,
    tailDelta,
    noResultText,
    resultText,
  } = scenario;
  emitAgentEvent({
    runId,
    stream: "assistant",
    data: {
      text: previousText,
      delta: previousText,
      ...(itemId ? { itemId } : replaceable ? { itemId: "answer-1" } : {}),
    },
  });
  emitAgentEvent({
    runId,
    stream: "assistant",
    data: {
      text: replacementText,
      ...(replacementDelta === undefined ? {} : { delta: replacementDelta }),
      replace: true,
      ...(itemId
        ? { itemId, delta: "" }
        : replaceable
          ? { itemId: "answer-2", replaceable: true }
          : { phase: "commentary" }),
    },
  });
  if (recoveryText !== undefined) {
    emitAgentEvent({
      runId,
      stream: "assistant",
      data: {
        text: recoveryText,
        ...(recoveryItemId
          ? { itemId: recoveryItemId, delta: recoveryText }
          : { delta: "", replace: true }),
      },
    });
  }
  if (terminalEcho) {
    emitAgentEvent({ runId, stream: "assistant", data: { text: replacementText } });
  }
  if (tailDelta) {
    emitAgentEvent({ runId, stream: "assistant", data: { delta: tailDelta } });
  }
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
  return {
    payloads: noResultText ? [] : [{ text: resultText ?? recoveryText ?? replacementText }],
  };
}

export function emitCompatibleAssistantReplacement(
  runId: string,
  scenario: CompatibleReplacementCase,
) {
  const {
    previousDelta,
    replacementDelta,
    replacementText = "final answer",
    replaceable,
    intermediateText,
    terminalEcho,
    noResultText,
    resultText,
  } = scenario;
  if (previousDelta) {
    emitAgentEvent({
      runId,
      stream: "assistant",
      data: {
        text: previousDelta,
        delta: previousDelta,
        ...(replaceable ? { itemId: "answer-1" } : {}),
      },
    });
  }
  if (intermediateText !== undefined) {
    emitAgentEvent({
      runId,
      stream: "assistant",
      data: {
        text: intermediateText,
        delta: "",
        replace: true,
        ...(replaceable ? { itemId: "answer-2", replaceable: true } : {}),
      },
    });
  }
  emitAgentEvent({
    runId,
    stream: "assistant",
    data: {
      text: replacementText,
      replace: true,
      ...(replaceable
        ? { itemId: intermediateText === undefined ? "answer-2" : "answer-3", replaceable: true }
        : { phase: "commentary" }),
      ...(replacementDelta === undefined ? {} : { delta: replacementDelta }),
    },
  });
  if (terminalEcho) {
    emitAgentEvent({ runId, stream: "assistant", data: { text: replacementText } });
  }
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
  return { payloads: noResultText ? [] : [{ text: resultText ?? replacementText }] };
}

export function emitBufferedAssistantReplacement(
  runId: string,
  scenario: Pick<BufferedReplacementCase, "replacement" | "finalText">,
) {
  const { replacement, finalText } = scenario;
  emitAgentEvent({
    runId,
    stream: "assistant",
    data: {
      text: "coordination draft",
      delta: "coordination draft",
      replaceable: true,
    },
  });
  emitAgentEvent({ runId, stream: "assistant", data: { ...replacement, replaceable: true } });
  if (finalText) {
    emitAgentEvent({ runId, stream: "assistant", data: { text: finalText } });
  }
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
  return { payloads: finalText ? [{ text: finalText }] : [] };
}

export function createOpenAiHttpTestClient(port: number): OpenAI {
  return new OpenAI({
    apiKey: "test",
    baseURL: `http://127.0.0.1:${port}/v1`,
    defaultHeaders: { "x-openclaw-scopes": "operator.write" },
    maxRetries: 0,
  });
}

export const streamingFailureCases = [
  {
    label: "terminal metadata",
    meta: { error: { kind: "incomplete_turn" as const, message: "private provider failure" } },
    expectedPhase: "error" as const,
  },
  {
    label: "an error stop reason",
    meta: { stopReason: "error" },
    expectedPhase: "end" as const,
  },
  {
    label: "a run-budget timeout without error metadata",
    meta: { aborted: false, timeoutPhase: "provider" as const, providerStarted: true },
    expectedPhase: "end" as const,
  },
].flatMap((failure) =>
  [false, true].map((producerTerminal) => ({
    meta: failure.meta,
    expectedPhase: failure.expectedPhase,
    producerTerminal,
    label: `${failure.label} ${producerTerminal ? "after" : "without"} a producer terminal`,
  })),
);

type StreamingFailureCase = (typeof streamingFailureCases)[number];

export function captureStreamingTerminals(getRunId: () => string | undefined) {
  const terminals: Array<{ phase: "end" | "error"; status: string }> = [];
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId === getRunId() && event.stream === "lifecycle") {
      const phase = event.data?.phase;
      if (phase === "end" || phase === "error") {
        terminals.push({
          phase,
          status: buildAgentRunTerminalOutcomeFromLifecycleEvent({ phase, data: event.data })
            .status,
        });
      }
    }
  });
  return { terminals, unsubscribe };
}

export function emitResolvedStreamingFailure(
  runId: string,
  { meta, producerTerminal }: Pick<StreamingFailureCase, "meta" | "producerTerminal">,
  additionalMeta: Record<string, unknown> = {},
) {
  emitAgentEvent({ runId, stream: "assistant", data: { delta: "partial answer" } });
  const result = {
    payloads: [{ text: "Command may have changed state", isError: true }],
    meta: { durationMs: 0, ...additionalMeta, ...meta },
  };
  if (producerTerminal) {
    const lifecycle = createAgentCommandLifecycle({
      runId,
      lifecycleGeneration: getAgentEventLifecycleGeneration,
      startedAt: Date.now(),
      state: {
        currentTurnUserMessagePersisted: true,
        lifecycleFinishing: false,
        lifecycleEnded: false,
      },
    });
    const terminal = {
      metadata: {},
      outcome: buildAgentRunTerminalOutcome({
        status: meta.timeoutPhase ? "timeout" : "error",
        stopReason: meta.timeoutPhase ? undefined : "error",
        timeoutPhase: meta.timeoutPhase,
      }),
    };
    if (lifecycle.resolveResultError(result, false)) {
      lifecycle.emitResultError(result, false, terminal);
    } else {
      lifecycle.emitEnd(terminal);
    }
  }
  return recordAgentRunTerminalOutcome(result, "failed");
}
