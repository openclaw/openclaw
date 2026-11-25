import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkerLiveEventSchema,
  type WorkerLiveEvent,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  jsonTool,
  resultDetails,
  resetCodeModeTestState,
} from "../agents/code-mode.test-support.js";
import { recordModelFallbackStop } from "../agents/failover-error.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { readAgentAssistantSource } from "../infra/agent-events.js";
import { createReplyOperation } from "../sessions/session-controller.js";
import { testing as sessionTesting } from "../sessions/session-controller.test-support.js";
import { createWorkerLiveRuntime } from "./embedded-agent-live.runtime.js";

const tool = { toolCallId: "tool-1", toolName: "read" };
type Message = ReturnType<typeof makeAgentAssistantMessage>;
const textMessage = (text: string) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }] });

function liveFixture(preview = true) {
  const emitted: WorkerLiveEvent[] = [];
  const runtime = createWorkerLiveRuntime({
    enqueuePreview: (event) => {
      if (preview) {
        emitted.push(event);
      }
      return preview;
    },
    emitTerminal: async (event) => void emitted.push(event),
  });
  return {
    emitted,
    runtime,
    send: runtime.handleSessionEvent,
    start: (message: Message) => runtime.handleSessionEvent({ type: "message_start", message }),
    finish: (message: Message) => runtime.handleSessionEvent({ type: "message_end", message }),
    update: (message: Message, delta: string, kind: "text" | "thinking" = "text") =>
      runtime.handleSessionEvent({
        type: "message_update",
        message,
        assistantMessageEvent:
          kind === "text"
            ? { type: "text_delta", contentIndex: 0, delta }
            : { type: "thinking_delta", contentIndex: 0, delta, partial: message },
      }),
    end: (message: Message) =>
      runtime.handleSessionEvent({ type: "agent_end", messages: [message], willRetry: false }),
    fail: (error: Error, aborted = false) => runtime.enqueueRunFailure({ error, aborted }),
  };
}

describe("createWorkerLiveRuntime", () => {
  afterEach(() => vi.useRealTimers());

  it("publishes a Code Mode guest's pending host call with its own tool name and ID", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:worker-host",
      sessionId: "worker-host",
      resetTriggered: false,
    });
    const attempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
    const events: WorkerLiveEvent[] = [];
    const live = createWorkerLiveRuntime({
      enqueuePreview(event) {
        events.push(event);
        if (event.kind === "tool" && event.payload.phase !== "update") {
          attempt.toolEvent({
            toolName: event.payload.name,
            toolCallId: event.payload.toolCallId,
            phase: event.payload.phase === "start" ? "start" : "end",
          });
        }
        return true;
      },
      emitTerminal: async () => {},
    });
    const started = createDeferred();
    const release = createDeferred();
    const target = jsonTool("host_wait", {});
    target.execute = async () => {
      started.resolve();
      await release.promise;
      return { content: [], details: {} };
    };
    const runtime = createAgentHarnessToolSurfaceRuntimeCore({
      agentId: "main",
      sessionId: "worker-host",
      sessionKey: operation.key,
      runId: "worker-host",
      config: { tools: { codeMode: true } },
      modelToolsEnabled: true,
      executeTool: live.executeTool,
    });
    try {
      const { tools } = runtime.compactTools([target]);
      const exec = tools.find((entry) => entry.name === "exec")!;
      const execution = exec.execute("guest-call", { code: "return await host_wait({});" });
      await started.promise;
      expect(operation.watchdog.snapshot().tools).toMatchObject([
        {
          toolName: "host_wait",
          toolCallId: expect.stringMatching(/^tool_call:guest-call:[^:]+:host_wait:1$/),
        },
      ]);
      expect(events.filter((event) => event.kind === "tool")).toMatchObject([
        {
          payload: {
            phase: "start",
            name: "host_wait",
            args: null,
            toolCallId: expect.stringMatching(/^tool_call:guest-call:[^:]+:host_wait:1$/),
          },
        },
      ]);
      expect(events.every((event) => Value.Check(WorkerLiveEventSchema, event))).toBe(true);
      release.resolve();
      expect(resultDetails(await execution).status).toBe("completed");
      expect(operation.watchdog.snapshot().tools).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        kind: "tool",
        payload: { phase: "result", result: null },
      });
    } finally {
      release.resolve();
      runtime.cleanup();
      operation.complete();
      sessionTesting.resetSessionControllerForTest();
      await resetCodeModeTestState();
    }
  });

  it.each(["text", "thinking"] as const)(
    "paces %s previews and flushes their exact delta before tool activity",
    (kind) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);
      const { emitted, start, finish, update, send } = liveFixture();
      const message = makeAgentAssistantMessage({ content: [] });
      start(message);
      let text = "";
      const append = (delta: string, time: number) => {
        vi.setSystemTime(time);
        text += delta;
        message.content =
          kind === "text" ? [{ type: "text", text }] : [{ type: "thinking", thinking: text }];
        update(message, delta, kind);
      };
      append("A", 1_000);
      append("界", 1_020);
      append("é", 1_040);
      expect(emitted).toHaveLength(1);
      append("\n", 1_075);
      append("end", 1_080);
      expect(emitted).toHaveLength(2);
      send({ type: "tool_execution_start", ...tool, args: {} });
      finish(message);
      const itemId = readAgentAssistantSource(message)?.itemId;
      expect(emitted).toEqual([
        ...[
          ["A", "A"],
          ["A界é\n", "界é\n"],
          ["A界é\nend", "end"],
        ].map(([snapshot, delta]) => ({
          kind: kind === "text" ? "assistant" : "thinking",
          payload: { text: snapshot, delta, itemId },
        })),
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
      const { emitted, runtime, start, finish, update, end } = liveFixture();
      const message = textMessage("Checked partial reply.");
      start(message);
      update(message, "Checked partial reply.");
      const pending = textMessage("Checked partial reply. More.");
      update(pending, " More.");
      expect(emitted).toHaveLength(1);
      const terminal = makeAgentAssistantMessage({ content: [], stopReason });
      finish(terminal);
      expect(
        emitted.filter((event) => event.kind === "assistant").map((event) => event.payload),
      ).toEqual([
        expect.objectContaining({ text: "Checked partial reply." }),
        expect.objectContaining({ text: "Checked partial reply. More.", delta: " More." }),
        ...(stopReason === "aborted" ? [] : [expect.objectContaining({ text: "", replace: true })]),
      ]);
      end(terminal);
      await runtime.emitTerminal();
      expect(emitted.at(-1)).toMatchObject({
        kind: "lifecycle",
        payload: { phase: "finishing", stopReason },
      });
    },
  );

  it("flushes late commentary metadata before starting a new assistant occurrence", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { emitted, start, finish, update, send } = liveFixture();
    const message = textMessage("Checking");
    start(message);
    update(message, "Checking");
    message.content = [{ type: "text", text: "Checking a detail." }];
    update(message, " a detail.");
    message.content = [
      {
        type: "text",
        text: "Checking a detail.",
        textSignature: '{"v":1,"id":"commentary-1","phase":"commentary"}',
      },
    ];
    send({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "text_end",
        contentIndex: 0,
        content: "Checking a detail.",
        partial: message,
      },
    });
    const final = textMessage("The answer.");
    start(final);
    finish(final);
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
    const { emitted, start, update } = liveFixture();
    const text = "Synthetic reasoning. ".repeat(2_000);
    const sources: string[] = [];
    for (let occurrence = 0; occurrence < 2; occurrence++) {
      const message = makeAgentAssistantMessage({
        content: [{ type: "thinking", thinking: text }],
      });
      start(message);
      update(message, text, "thinking");
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
    const { emitted, start, finish, update } = liveFixture();
    const message = textMessage("MEDIA:./report.txt");
    start(message);
    update(message, "MEDIA:./report.txt");
    expect(emitted).toEqual([
      expect.objectContaining({
        payload: expect.not.objectContaining({ mediaUrls: expect.anything() }),
      }),
    ]);
    finish(message);
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
    const { emitted, send } = liveFixture();
    const events: AgentSessionEvent[] = [
      {
        type: "tool_execution_start",
        ...tool,
        args: { type: "video", data: Buffer.from([1, 2, 3]) },
      },
      {
        type: "tool_execution_update",
        ...tool,
        args: {},
        partialResult: { mimeType: "audio/mpeg", blob: new Uint8Array([4, 5, 6]) },
      },
      {
        type: "tool_execution_end",
        ...tool,
        result: "failed data:video/mp4;base64,QUJDRA==",
        isError: true,
      },
    ];

    for (const event of events) {
      send(event);
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
      const { emitted, runtime, send, end, fail } = liveFixture(false);
      send({ type: "agent_start" });
      end(
        makeAgentAssistantMessage({
          content: [],
          stopReason,
          errorMessage: "inference failed data:video/mp4;base64,QUJDRA==",
        }),
      );
      if (cleanupFailed) {
        fail(new Error("cleanup failed data:video/mp4;base64,QUJDRA=="));
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
      const { emitted, runtime, end, fail } = liveFixture(false);
      const failure = Object.freeze(new Error("request timed out"));
      if (recordedStop) {
        recordModelFallbackStop(failure);
      }
      fail(new AggregateError([failure], "wrapper"));
      end(makeAgentAssistantMessage({ content: [], stopReason: aborted ? "aborted" : "stop" }));
      fail(new Error("later provider failure"));
      await runtime.emitTerminal();

      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.payload).toMatchObject({
        phase: "finishing",
        stopReason: aborted ? "aborted" : "error",
        error: "later provider failure",
      });
      if (recordedStop) {
        expect(emitted[0]?.payload).toHaveProperty("replayInvalid", true);
      } else {
        expect(emitted[0]?.payload).not.toHaveProperty("replayInvalid");
      }
    },
  );
  it("retains and redacts interruption errors before terminal cloud egress", async () => {
    const { emitted, runtime, fail } = liveFixture(false);

    fail(
      new AggregateError(
        [new Error(`native close failed data:video/mp4;base64,QUJDRA== ${"x".repeat(8_000)}`)],
        "Runtime-local inference lost Gateway admission",
      ),
      true,
    );
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
