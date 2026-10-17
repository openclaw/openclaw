import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkerLiveEventSchema,
  type WorkerLiveEvent,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { recordModelFallbackStop } from "../agents/failover-error.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { readAgentAssistantSource } from "../infra/agent-events.js";
import { createWorkerLiveRuntime } from "./embedded-agent-live.runtime.js";

describe("createWorkerLiveRuntime", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["text", "thinking"] as const)(
    "paces %s previews and flushes their exact delta before tool activity",
    (kind) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);
      const emitted: WorkerLiveEvent[] = [];
      const runtime = createWorkerLiveRuntime({
        enqueuePreview: (event) => {
          emitted.push(event);
          return true;
        },
        emitTerminal: async () => {},
      });
      const message = makeAgentAssistantMessage({ content: [] });
      runtime.handleSessionEvent({ type: "message_start", message });
      let text = "";
      const append = (delta: string, time: number) => {
        vi.setSystemTime(time);
        text += delta;
        message.content =
          kind === "text" ? [{ type: "text", text }] : [{ type: "thinking", thinking: text }];
        runtime.handleSessionEvent({
          type: "message_update",
          message,
          assistantMessageEvent:
            kind === "text"
              ? { type: "text_delta", contentIndex: 0, delta }
              : { type: "thinking_delta", contentIndex: 0, delta, partial: message },
        });
      };
      append("A", 1_000);
      append("界", 1_020);
      append("é", 1_040);
      expect(emitted).toHaveLength(1);
      append("\n", 1_075);
      append("end", 1_080);
      expect(emitted).toHaveLength(2);
      runtime.handleSessionEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: {},
      });
      runtime.handleSessionEvent({ type: "message_end", message });
      const itemId = readAgentAssistantSource(message)?.itemId;
      expect(emitted).toEqual([
        {
          kind: kind === "text" ? "assistant" : "thinking",
          payload: { text: "A", delta: "A", itemId },
        },
        {
          kind: kind === "text" ? "assistant" : "thinking",
          payload: { text: "A界é\n", delta: "界é\n", itemId },
        },
        {
          kind: kind === "text" ? "assistant" : "thinking",
          payload: { text: "A界é\nend", delta: "end", itemId },
        },
        { kind: "tool", payload: { phase: "start", name: "read", toolCallId: "tool-1", args: {} } },
      ]);
      expect(message.content).toEqual(
        kind === "text"
          ? [{ type: "text", text: "A界é\nend" }]
          : [{ type: "thinking", thinking: "A界é\nend" }],
      );
    },
  );

  it.each(["aborted", "error", "stop"] as const)(
    "handles an empty %s final after checked text was streamed",
    async (stopReason) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const emitted: WorkerLiveEvent[] = [];
      const runtime = createWorkerLiveRuntime({
        enqueuePreview: (event) => {
          emitted.push(event);
          return true;
        },
        emitTerminal: async (event) => void emitted.push(event),
      });
      const message = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Checked partial reply." }],
      });
      runtime.handleSessionEvent({ type: "message_start", message });
      runtime.handleSessionEvent({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Checked partial reply.",
        },
      });
      const pending = makeAgentAssistantMessage({
        content: [{ type: "text", text: "Checked partial reply. More." }],
      });
      runtime.handleSessionEvent({
        type: "message_update",
        message: pending,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " More." },
      });
      expect(emitted).toHaveLength(1);
      const terminal = makeAgentAssistantMessage({ content: [], stopReason });
      runtime.handleSessionEvent({ type: "message_end", message: terminal });
      expect(
        emitted.filter((event) => event.kind === "assistant").map((event) => event.payload),
      ).toEqual([
        expect.objectContaining({ text: "Checked partial reply." }),
        expect.objectContaining({ text: "Checked partial reply. More.", delta: " More." }),
        ...(stopReason === "aborted" ? [] : [expect.objectContaining({ text: "", replace: true })]),
      ]);
      runtime.handleSessionEvent({ type: "agent_end", messages: [terminal], willRetry: false });
      await runtime.emitTerminal();
      expect(emitted.at(-1)).toMatchObject({
        kind: "lifecycle",
        payload: { phase: "finishing", stopReason },
      });
    },
  );

  it("flushes late commentary metadata before starting a new assistant occurrence", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: (event) => {
        emitted.push(event);
        return true;
      },
      emitTerminal: async () => {},
    });
    const message = makeAgentAssistantMessage({ content: [{ type: "text", text: "Checking" }] });
    runtime.handleSessionEvent({ type: "message_start", message });
    runtime.handleSessionEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Checking" },
    });
    message.content = [{ type: "text", text: "Checking a detail." }];
    runtime.handleSessionEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " a detail." },
    });
    message.content = [
      {
        type: "text",
        text: "Checking a detail.",
        textSignature: '{"v":1,"id":"commentary-1","phase":"commentary"}',
      },
    ];
    runtime.handleSessionEvent({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Checking a detail.",
        partial: message,
      },
    });
    const final = makeAgentAssistantMessage({ content: [{ type: "text", text: "The answer." }] });
    runtime.handleSessionEvent({ type: "message_start", message: final });
    runtime.handleSessionEvent({ type: "message_end", message: final });
    expect(emitted.map((event) => event.payload)).toEqual([
      { text: "Checking", delta: "Checking", itemId: readAgentAssistantSource(message)?.itemId },
      {
        text: "Checking a detail.",
        delta: " a detail.",
        phase: "commentary",
        itemId: readAgentAssistantSource(message)?.itemId,
      },
      {
        text: "The answer.",
        delta: "The answer.",
        itemId: readAgentAssistantSource(final)?.itemId,
      },
    ]);
    expect(readAgentAssistantSource(message)?.itemId).not.toBe(
      readAgentAssistantSource(final)?.itemId,
    );
  });

  it("keeps distinct reasoning occurrences through bounded worker payloads", () => {
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: (event) => {
        emitted.push(event);
        return true;
      },
      emitTerminal: async () => {},
    });
    const text = "Synthetic reasoning. ".repeat(2_000);
    const sources: string[] = [];
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      const message = makeAgentAssistantMessage({
        content: [{ type: "thinking", thinking: text }],
      });
      runtime.handleSessionEvent({ type: "message_start", message });
      runtime.handleSessionEvent({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: text,
          partial: message,
        },
      });
      const source = readAgentAssistantSource(message);
      if (!source?.itemId) {
        throw new Error("Worker persistence requires the source occurrence");
      }
      sources.push(source.itemId);
    }
    expect(emitted.map((event) => Value.Check(WorkerLiveEventSchema, event))).toEqual([true, true]);
    expect(emitted.map((event) => event.payload)).toEqual(
      sources.map((itemId) => ({ itemId, text: expect.any(String), delta: expect.any(String) })),
    );
    expect(sources[0]).not.toBe(sources[1]);
    expect(emitted.every((event) => JSON.stringify(event).length < text.length)).toBe(true);
  });

  it("publishes attachment references only when the assistant message is complete", () => {
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: (event) => {
        emitted.push(event);
        return true;
      },
      emitTerminal: async () => {},
    });
    const message = makeAgentAssistantMessage({
      content: [{ type: "text", text: "MEDIA:./report.txt" }],
    });
    runtime.handleSessionEvent({ type: "message_start", message });
    runtime.handleSessionEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "MEDIA:./report.txt" },
    });
    expect(emitted).toEqual([
      expect.objectContaining({
        payload: expect.not.objectContaining({ mediaUrls: expect.anything() }),
      }),
    ]);
    runtime.handleSessionEvent({ type: "message_end", message });
    expect(emitted.at(-1)).toMatchObject({
      kind: "assistant",
      payload: {
        text: "MEDIA:./report.txt",
        delta: "",
        mediaUrls: ["./report.txt"],
      },
    });
    expect(message.content).toEqual([{ type: "text", text: "MEDIA:./report.txt" }]);
  });

  it("redacts media payloads from tool diagnostics before cloud egress", () => {
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: (event) => {
        emitted.push(event);
        return true;
      },
      emitTerminal: async (event) => void emitted.push(event),
    });
    const events: AgentSessionEvent[] = [
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { type: "video", data: Buffer.from([1, 2, 3]) },
      },
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        args: {},
        partialResult: { mimeType: "audio/mpeg", blob: new Uint8Array([4, 5, 6]) },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: "failed data:video/mp4;base64,QUJDRA==",
        isError: true,
      },
    ];

    for (const event of events) {
      runtime.handleSessionEvent(event);
    }
    expect(JSON.stringify(emitted)).not.toContain("QUJDRA==");
    expect(JSON.stringify(emitted)).not.toMatch(/"[0-9]+":(?:[0-9]+|\{)/u);
    expect(emitted).toHaveLength(3);
  });

  it.each([
    { stopReason: "error", cleanupFailed: false, expectedStopReason: "error" },
    { stopReason: "stop", cleanupFailed: true, expectedStopReason: "error" },
    { stopReason: "aborted", cleanupFailed: true, expectedStopReason: "aborted" },
  ] as const)(
    "preserves deferred $stopReason terminal after preview loss (cleanup failure: $cleanupFailed)",
    async ({ stopReason, cleanupFailed, expectedStopReason }) => {
      const emitted: WorkerLiveEvent[] = [];
      const runtime = createWorkerLiveRuntime({
        enqueuePreview: () => false,
        emitTerminal: async (event) => void emitted.push(event),
      });
      runtime.handleSessionEvent({ type: "agent_start" });
      runtime.handleSessionEvent({
        type: "agent_end",
        messages: [
          makeAgentAssistantMessage({
            content: [],
            stopReason,
            errorMessage: "inference failed data:video/mp4;base64,QUJDRA==",
          }),
        ],
        willRetry: false,
      });
      if (cleanupFailed) {
        runtime.enqueueRunFailure({
          aborted: false,
          error: new Error("cleanup failed data:video/mp4;base64,QUJDRA=="),
        });
      }
      expect(emitted).toEqual([]);
      await runtime.emitTerminal();
      expect(emitted).toEqual([
        {
          kind: "lifecycle",
          payload: {
            phase: "finishing",
            startedAt: expect.any(Number),
            endedAt: expect.any(Number),
            stopReason: expectedStopReason,
            ...(expectedStopReason === "aborted" ? { aborted: true } : {}),
            error: expect.stringContaining(cleanupFailed ? "cleanup failed" : "inference failed"),
          },
        },
      ]);
      expect(JSON.stringify(emitted)).not.toContain("QUJDRA==");
    },
  );

  it.each([
    { recordedStop: false, aborted: false },
    { recordedStop: true, aborted: false },
    { recordedStop: false, aborted: true },
    { recordedStop: true, aborted: true },
  ])(
    "retains only recorded replay stops across terminal merges ($recordedStop, $aborted)",
    async ({ recordedStop, aborted }) => {
      const emitted: WorkerLiveEvent[] = [];
      const runtime = createWorkerLiveRuntime({
        enqueuePreview: () => false,
        emitTerminal: async (event) => void emitted.push(event),
      });
      const failure = Object.freeze(new Error("request timed out"));
      if (recordedStop) {
        recordModelFallbackStop(failure);
      }
      runtime.enqueueRunFailure({
        aborted: false,
        error: new AggregateError([failure], "wrapper"),
      });
      runtime.handleSessionEvent({
        type: "agent_end",
        messages: [
          makeAgentAssistantMessage({ content: [], stopReason: aborted ? "aborted" : "stop" }),
        ],
        willRetry: false,
      });
      runtime.enqueueRunFailure({ aborted: false, error: new Error("later provider failure") });
      await runtime.emitTerminal();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({
        phase: "finishing",
        stopReason: aborted ? "aborted" : "error",
      });
      if (recordedStop) {
        expect(emitted[0]?.payload).toHaveProperty("replayInvalid", true);
      } else {
        expect(emitted[0]?.payload).not.toHaveProperty("replayInvalid");
      }
      expect(emitted[0]?.payload).toHaveProperty("error", "later provider failure");
    },
  );

  it("retains and redacts interruption errors before terminal cloud egress", async () => {
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: () => false,
      emitTerminal: async (event) => void emitted.push(event),
    });

    runtime.enqueueRunFailure({
      aborted: true,
      error: new AggregateError(
        [new Error(`native close failed data:video/mp4;base64,QUJDRA== ${"x".repeat(8_000)}`)],
        "Runtime-local inference lost Gateway admission",
      ),
    });
    await runtime.emitTerminal();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      phase: "finishing",
      stopReason: "aborted",
      aborted: true,
      error: expect.stringContaining(
        "Runtime-local inference lost Gateway admission | native close failed",
      ),
    });
    expect(JSON.stringify(emitted)).not.toContain("QUJDRA==");
    const event = emitted[0];
    if (event?.kind !== "lifecycle" || event.payload.phase !== "finishing") {
      throw new Error("expected a finishing event");
    }
    expect(Buffer.byteLength(event.payload.error ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
  });
});
