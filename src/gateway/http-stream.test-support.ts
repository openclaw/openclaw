import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import OpenAI from "openai";
import { expect } from "vitest";
import {
  buildAgentRunTerminalOutcome,
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
} from "../agents/agent-run-terminal-outcome.js";
import { createAgentCommandLifecycle } from "../agents/command/lifecycle.js";
import {
  createSubscribedSessionHarness,
  emitToolRun,
} from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { recordAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import {
  emitAgentEvent,
  onAgentEvent,
  getAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";

type SseEvent = { event?: string; data: string };

export async function emitEmbeddedLateCommentary(opts: unknown): Promise<void> {
  const runId = asOptionalObjectRecord(opts)?.runId;
  if (typeof runId !== "string" || !runId) {
    throw new Error("Expected a streaming HTTP run identity");
  }
  const { emit, subscription } = createSubscribedSessionHarness({ runId });
  const commentary = "I will inspect the workspace.";
  const finalText = "The check is complete.";
  const message = (text: string) =>
    makeAgentAssistantMessage({
      api: "openai-completions",
      content: [{ type: "text", text }],
    });
  const emitText = (text: string) => {
    const snapshot = message(text);
    emit({ type: "message_start", message: message("") });
    emit({
      type: "message_update",
      message: snapshot,
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
    return snapshot;
  };
  try {
    emitText(commentary);
    const completedCommentary = makeAgentAssistantMessage({
      api: "openai-completions",
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: commentary,
          textSignature: JSON.stringify({ v: 1, id: "commentary-http", phase: "commentary" }),
        },
        { type: "toolCall", id: "read-http", name: "read", arguments: {} },
      ],
    });
    emit({
      type: "message_update",
      message: completedCommentary,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 1,
        partial: completedCommentary,
      },
    });
    emit({ type: "message_end", message: completedCommentary });
    emitToolRun({
      emit,
      toolName: "read",
      toolCallId: "read-http",
      args: {},
      isError: false,
      result: { content: [{ type: "text", text: "Read complete." }] },
    });
    const finalMessage = emitText(finalText);
    emit({ type: "message_end", message: finalMessage });
    emit({ type: "agent_end", messages: [completedCommentary, finalMessage] });
    await subscription.waitForPendingEvents();
  } finally {
    subscription.unsubscribe();
  }
}

export function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const lines = text.split("\n");
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice("event: ".length);
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice("data: ".length));
    } else if (line.trim() === "" && currentData.length > 0) {
      events.push({ event: currentEvent, data: currentData.join("\n") });
      currentEvent = undefined;
      currentData = [];
    }
  }

  return events;
}

export function collectSseEventTypes(events: readonly SseEvent[]): string[] {
  return events.flatMap(({ event }) => (event ? [event] : []));
}

export function findSseEvent(events: SseEvent[], eventName: string): SseEvent {
  const event = events.find((candidate) => candidate.event === eventName);
  if (!event) {
    throw new Error(`expected SSE event ${eventName}`);
  }
  return event;
}

export function parseSseData(event: SseEvent): unknown {
  return JSON.parse(event.data) as unknown;
}

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
  const snapshot = (item: number, text: string, delta?: string) => ({
    itemId: `answer-${item}`,
    text,
    ...(delta === undefined ? {} : { delta }),
  });
  const delta = (text: string) => ({ itemId: "answer-2", delta: text });
  const echo = (item: number) => snapshot(item, "Echo", "Echo");
  const longText = "x".repeat(500_001);
  const scenario = (
    name: string,
    expected: string,
    events: AssistantSnapshotCase["events"],
    resultTexts?: string[],
  ) => ({ name, expected, events, resultTexts });
  const growing = [echo(1), echo(1), echo(2), echo(2), snapshot(2, "Echo!", "!")];
  const empty = [snapshot(1, "First."), delta(""), delta("Second."), snapshot(2, "Second.")];
  const beyondCap = [snapshot(1, longText, longText), snapshot(2, "tail", "tail")];
  return [
    leading,
    scenario("replayed and growing items", "Echo\n\nEcho!", growing, ["Echo", "Echo!"]),
    scenario("empty items before deltas", "First.\n\nSecond.", empty),
    scenario("text beyond the live display cap", `${longText}\n\ntail`, beyondCap),
  ];
}

type ReplacementCase = {
  name: string;
  replaceable?: boolean;
  resultText?: string;
  noResultText?: boolean;
  terminalEcho?: boolean;
};
type IncompatibleReplacementCase = ReplacementCase & {
  replacementText: string;
  itemId?: string;
  recoveryItemId?: string;
  previousText?: string;
  recoveryText?: string;
  tailDelta?: string;
};

function clearedBeforeRecovery(name: string, recoveryItemId: string): IncompatibleReplacementCase {
  return {
    name,
    itemId: "failed-answer",
    replacementText: "",
    recoveryItemId,
    recoveryText: "recovered answer",
  };
}

function namedCases<T extends object>(base: T, rows: [string, Partial<T>][]) {
  return rows.map(([name, overrides]) => Object.assign({ name }, base, overrides));
}

export const incompatibleReplacementCases: IncompatibleReplacementCase[] = [
  ...namedCases<Omit<IncompatibleReplacementCase, "name">>({ replacementText: "" }, [
    ["rewritten then extended by a delta", { replacementText: "other answer", tailDelta: "!" }],
    ["cleared", {}],
  ]),
  ...namedCases<Omit<IncompatibleReplacementCase, "name">>(
    { previousText: "Echo", replaceable: true, replacementText: "Replacement" },
    [
      ["replaced by a held provisional item", {}],
      [
        "cleared by an explicit empty final result",
        { replacementText: "Echo tail", resultText: "" },
      ],
      [
        "cleared by held output without a text-bearing result",
        { replacementText: "", noResultText: true },
      ],
      ["replaced by held text with a native echo", { terminalEcho: true }],
    ],
  ),
  clearedBeforeRecovery("cleared before same-ID recovery", "failed-answer"),
  clearedBeforeRecovery("cleared before distinct-ID recovery", "recovery-answer"),
];

type CompatibleReplacementCase = ReplacementCase & {
  previousDelta?: string;
  replacementDelta?: string;
  replacementText?: string;
  intermediateText?: string;
};

export const compatibleReplacementCases: CompatibleReplacementCase[] = [
  ...namedCases<Omit<CompatibleReplacementCase, "name">>({}, [
    ["a snapshot without a delta", {}],
    ["an append after partial text", { previousDelta: "final ", replacementDelta: "answer" }],
  ]),
  ...namedCases<Omit<CompatibleReplacementCase, "name">>(
    {
      previousDelta: "Echo",
      replacementText: "Echo tail",
      replacementDelta: "",
      replaceable: true,
    },
    [
      ["a corrected held replacement", { intermediateText: "Replacement" }],
      ["held text without a final payload", { noResultText: true }],
      [
        "a cleared initial draft",
        { previousDelta: undefined, replacementText: "Draft", resultText: "" },
      ],
      ["a held replacement with its native echo", { terminalEcho: true }],
      [
        "a recovered native echo",
        { replacementText: "Replacement", resultText: "Echo tail", terminalEcho: true },
      ],
    ],
  ),
];

type BufferedReplacementCase = {
  name: string;
  replacement: { text?: string; delta?: string; replace?: boolean };
  finalText: string;
  expected: string;
};

function bufferedReplacement(
  name: string,
  replacement: BufferedReplacementCase["replacement"],
  expected = "No response from OpenClaw.",
): BufferedReplacementCase {
  return { name, replacement, finalText: replacement.text ?? "", expected };
}

export const bufferedReplacementCases: BufferedReplacementCase[] = [
  bufferedReplacement(
    "a completed replacement",
    { text: "final answer", delta: "", replace: true },
    "final answer",
  ),
  bufferedReplacement("an empty snapshot", { text: "", delta: "" }),
  bufferedReplacement("an empty replacement snapshot", { text: "", delta: "", replace: true }),
  bufferedReplacement("an empty delta without a snapshot", { delta: "" }, "coordination draft"),
];

export function emitIncompatibleAssistantReplacement(
  runId: string,
  scenario: IncompatibleReplacementCase,
  replacementDelta: "" | undefined,
) {
  return emitReplacement(
    runId,
    scenario,
    scenario.previousText ?? "draft answer",
    replacementDelta,
  );
}

export function emitCompatibleAssistantReplacement(
  runId: string,
  scenario: CompatibleReplacementCase,
) {
  return emitReplacement(
    runId,
    { ...scenario, replacementText: scenario.replacementText ?? "final answer" },
    scenario.previousDelta || undefined,
    scenario.replacementDelta,
  );
}

function emitReplacement(
  runId: string,
  scenario: IncompatibleReplacementCase & CompatibleReplacementCase,
  previousText: string | undefined,
  replacementDelta: string | undefined,
) {
  const { itemId, replacementText, replaceable, intermediateText, recoveryText, recoveryItemId } =
    scenario;
  const emit = assistantEmitter(runId);
  if (previousText !== undefined) {
    emit({
      text: previousText,
      delta: previousText,
      ...(itemId ? { itemId } : replaceable ? { itemId: "answer-1" } : {}),
    });
  }
  if (intermediateText !== undefined) {
    emit({
      text: intermediateText,
      delta: "",
      replace: true,
      ...(replaceable ? { itemId: "answer-2", replaceable: true } : {}),
    });
  }
  emit({
    text: replacementText,
    replace: true,
    ...(replacementDelta === undefined ? {} : { delta: replacementDelta }),
    ...(itemId
      ? { itemId, delta: "" }
      : replaceable
        ? { itemId: intermediateText === undefined ? "answer-2" : "answer-3", replaceable: true }
        : { phase: "commentary" }),
  });
  if (recoveryText !== undefined) {
    emit({
      text: recoveryText,
      ...(recoveryItemId
        ? { itemId: recoveryItemId, delta: recoveryText }
        : { delta: "", replace: true }),
    });
  }
  if (scenario.terminalEcho) {
    emit({ text: replacementText });
  }
  if (scenario.tailDelta) {
    emit({ delta: scenario.tailDelta });
  }
  return finishAssistant(
    runId,
    scenario.noResultText ? undefined : (scenario.resultText ?? recoveryText ?? replacementText),
  );
}

export function emitBufferedAssistantReplacement(
  runId: string,
  scenario: Pick<BufferedReplacementCase, "replacement" | "finalText">,
) {
  const { replacement, finalText } = scenario;
  const emit = assistantEmitter(runId);
  emit({
    text: "coordination draft",
    delta: "coordination draft",
    replaceable: true,
  });
  emit({ ...replacement, replaceable: true });
  if (finalText) {
    emit({ text: finalText });
  }
  return finishAssistant(runId, finalText || undefined);
}

function finishAssistant(runId: string, text: string | undefined) {
  emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end" } });
  return { payloads: text === undefined ? [] : [{ text }] };
}

function assistantEmitter(runId: string) {
  return (data: Parameters<typeof emitAgentEvent>[0]["data"]) =>
    emitAgentEvent({ runId, stream: "assistant", data });
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
