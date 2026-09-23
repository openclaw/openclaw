import { describe, expect, it, vi } from "vitest";
import type { WorkerLiveEvent } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { recordModelFallbackStop } from "../agents/failover-error.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createWorkerLiveRuntime } from "./embedded-agent-live.runtime.js";

describe("createWorkerLiveRuntime", () => {
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

  it("stops preparing previews after the client degrades", () => {
    let previewCalls = 0;
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: () => {
        previewCalls += 1;
        return false;
      },
      emitTerminal: async () => {},
    });

    const readPayload = vi.fn(() => ({ mimeType: "image/png", data: "QUJDRA==" }));
    const message = makeAgentAssistantMessage({
      content: [
        { type: "text", text: "ignored answer" },
        { type: "thinking", thinking: "ignored reasoning" },
      ],
    });
    const messageContent = message.content;
    const readContent = vi.fn(() => messageContent);
    Object.defineProperty(message, "content", { get: readContent });
    const events: AgentSessionEvent[] = [
      { type: "message_start", message },
      {
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "answer" },
      },
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "ignored answer",
          partial: message,
        },
      },
      {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "reasoning",
          partial: message,
        },
      },
      { type: "message_end", message },
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        get args() {
          return readPayload();
        },
      },
      {
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        args: {},
        get partialResult() {
          return readPayload();
        },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        isError: false,
        get result() {
          return readPayload();
        },
      },
    ];
    runtime.handleSessionEvent({ type: "agent_start" });
    for (const event of events) {
      runtime.handleSessionEvent(event);
    }

    expect({
      previewCalls,
      payloadReads: readPayload.mock.calls.length,
      contentReads: readContent.mock.calls.length,
    }).toEqual({ previewCalls: 1, payloadReads: 0, contentReads: 0 });
  });

  it.each([
    { stopReason: "stop", cleanupFailed: false, expectedStopReason: "stop" },
    { stopReason: "error", cleanupFailed: false, expectedStopReason: "error" },
    { stopReason: "aborted", cleanupFailed: false, expectedStopReason: "aborted" },
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
            ...(expectedStopReason === "error"
              ? {
                  error: expect.stringContaining(
                    cleanupFailed ? "cleanup failed" : "inference failed",
                  ),
                }
              : {}),
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
      if (aborted) {
        expect(emitted[0]?.payload).not.toHaveProperty("error");
      }
    },
  );

  it("redacts lifecycle errors before terminal cloud egress", async () => {
    const emitted: WorkerLiveEvent[] = [];
    const runtime = createWorkerLiveRuntime({
      enqueuePreview: () => false,
      emitTerminal: async (event) => void emitted.push(event),
    });

    runtime.enqueueRunFailure({
      aborted: false,
      error: new AggregateError(
        [new Error(`native close failed data:video/mp4;base64,QUJDRA== ${"x".repeat(8_000)}`)],
        "cleanup failed",
      ),
    });
    await runtime.emitTerminal();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload).toMatchObject({
      phase: "finishing",
      stopReason: "error",
      error: expect.stringContaining("cleanup failed | native close failed"),
    });
    expect(JSON.stringify(emitted)).not.toContain("QUJDRA==");
    const event = emitted[0];
    if (event?.kind !== "lifecycle" || event.payload.phase !== "finishing") {
      throw new Error("expected a finishing event");
    }
    expect(Buffer.byteLength(event.payload.error ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
  });
});
