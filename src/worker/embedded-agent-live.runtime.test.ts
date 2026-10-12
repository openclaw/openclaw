import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
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
