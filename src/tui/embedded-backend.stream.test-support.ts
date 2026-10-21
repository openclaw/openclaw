import { expect, it, onTestFinished, vi } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import type { EmbeddedTuiBackend } from "./embedded-backend.js";
import { deferred } from "./embedded-backend.test-helpers.js";

export function captureBackendEvents(backend: EmbeddedTuiBackend) {
  const events: Array<{ event: string; payload: unknown }> = [];
  backend.onEvent = ({ event, payload }) => {
    events.push({ event, payload });
  };
  return events;
}

type EmbeddedAgentResult = {
  payloads: Array<{ text: string }>;
  meta: Record<string, unknown>;
};

type StreamTestContext = {
  createBackend: () => EmbeddedTuiBackend;
  createPendingReply: () => {
    promise: Promise<EmbeddedAgentResult>;
    resolve: (result: EmbeddedAgentResult) => void;
  };
  prepareReply: (
    reply: Promise<EmbeddedAgentResult>,
    onStart?: (signal: AbortSignal) => void,
  ) => void;
  emitAgentEvent: (event: unknown) => void;
  flushMicrotasks: () => Promise<void>;
  embeddedEventTimestamp: number;
};

export function registerEmbeddedBackendStreamTests({
  createBackend,
  createPendingReply,
  prepareReply,
  emitAgentEvent,
  flushMicrotasks,
  embeddedEventTimestamp,
}: StreamTestContext) {
  it.each([
    { method: "abortChat", wait: "pending", caveat: true },
    { method: "abortChat", wait: "absent", caveat: false },
    { method: "abortChat", wait: "cleared", caveat: false },
    { method: "stop command", wait: "pending", caveat: true },
    { method: "stop command", wait: "absent", caveat: false },
    { method: "stop command", wait: "cleared", caveat: false },
  ])(
    "reports cancellation eligibility for $method with $wait wait",
    async ({ method, wait, caveat }) => {
      const pending = createPendingReply();
      const started = deferred<AbortSignal>();
      const runId = `local-cancel-${method}-${wait}`;
      const sessionKey = "agent:main:main";
      registerAgentRunContext(runId, { sessionKey });
      onTestFinished(() => clearAgentRunContext(runId));
      const context = getAgentRunContext(runId);
      if (!context) {
        throw new Error("Expected the test run to be registered");
      }
      prepareReply(pending.promise, (signal) => {
        signal.addEventListener("abort", () => delete context.localModelWait, { once: true });
        started.resolve(signal);
      });
      const backend = createBackend();
      const events = captureBackendEvents(backend);
      backend.start();
      await backend.sendChat({ sessionKey, message: "long task", runId });
      const signal = await started.promise;
      if (wait !== "absent") {
        context.localModelWait = { requestId: `${runId}:model:1` };
      }
      if (wait === "cleared") {
        delete context.localModelWait;
      }
      const abort = async () => {
        if (method === "abortChat") {
          expect(await backend.abortChat({ sessionKey, runId })).toEqual({
            ok: true,
            aborted: true,
            runIds: [runId],
          });
        } else {
          await backend.sendChat({ sessionKey, message: "/stop" });
        }
      };
      await abort();
      expect(signal.aborted).toBe(true);
      expect(context.localModelWait).toBeUndefined();
      await abort();
      pending.resolve({ payloads: [], meta: { aborted: true } });
      await flushMicrotasks();
      expect(events.filter((event) => event.event === "chat")).toEqual([
        {
          event: "chat",
          payload: {
            runId,
            sessionKey,
            agentId: "main",
            state: "aborted",
            ...(caveat ? { localModelMayStillBeFinishing: true } : {}),
          },
        },
      ]);
    },
  );

  it("paces display deltas and flushes them before tools, corrections, and completion", async () => {
    const pending = createPendingReply();
    prepareReply(pending.promise);
    const backend = createBackend();
    const events = captureBackendEvents(backend);
    const runId = "run-local-paced";
    backend.start();
    await backend.sendChat({ sessionKey: "agent:main:main", message: "pace text", runId });
    const append = (delta: string) =>
      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { itemId: "raw", text: "Raw provider snapshot", delta },
        assistantProjection: { itemId: "display", delta, replace: false },
      });
    const chat = () => events.filter((event) => event.event === "chat");
    append("Hello");
    append(" ");
    append("world");
    expect(chat().map((event) => event.payload)).toEqual([
      expect.objectContaining({ state: "delta", deltaText: "Hello" }),
    ]);
    expect(events.filter((event) => event.event === "agent")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(75);
    expect(chat().at(-1)?.payload).toMatchObject({ deltaText: " world" });

    append("!");
    emitAgentEvent({ runId, stream: "tool", data: { phase: "start", name: "exec" } });
    expect(events.slice(-2)).toMatchObject([
      { event: "chat", payload: { deltaText: "!" } },
      { event: "agent", payload: { stream: "tool" } },
    ]);
    append(" discarded");
    emitAgentEvent({
      runId,
      stream: "assistant",
      data: { text: "Raw provider correction", replace: true },
      assistantProjection: { itemId: "display", text: "Corrected", replace: true },
    });
    expect(
      chat()
        .slice(-2)
        .map((event) => event.payload),
    ).toMatchObject([{ deltaText: " discarded" }, { deltaText: "Corrected", replace: true }]);

    append(" final");
    pending.resolve({ payloads: [], meta: {} });
    await flushMicrotasks();
    expect(chat().at(-1)?.payload).toMatchObject({
      state: "final",
      message: { content: [{ text: "Corrected final" }] },
    });
    const delivered = events.length;
    await vi.advanceTimersByTimeAsync(75);
    expect(events).toHaveLength(delivered);
  });

  it("keeps internal context private when local deltas split its delimiters", async () => {
    const pending = createPendingReply();
    prepareReply(pending.promise);

    const backend = createBackend();
    const events = captureBackendEvents(backend);
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "split internal context",
      runId: "run-local-split-context",
    });

    const deltas = [
      `Visible\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n`,
      "private runtime detail\n",
      `${INTERNAL_RUNTIME_CONTEXT_END}\nAfter`,
    ];
    deltas.forEach((delta) => {
      emitAgentEvent({
        runId: "run-local-split-context",
        stream: "assistant",
        data: { delta },
      });
    });
    emitAgentEvent({
      runId: "run-local-split-context",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });
    pending.resolve({ payloads: [{ text: "Visible\n\nAfter" }], meta: {} });
    await flushMicrotasks();

    const chatPayloads = events
      .filter((entry) => entry.event === "chat")
      .map((entry) => entry.payload);
    expect(JSON.stringify(chatPayloads)).not.toContain("private runtime detail");
    expect(chatPayloads.at(-1)).toMatchObject({
      state: "final",
      message: { content: [{ text: "Visible\n\nAfter" }] },
    });
  });

  it.each([
    {
      name: "unkeyed replacement snapshots",
      updates: [{ text: "Hello world" }, { text: "Goodbye world" }],
      expectedDeltas: [
        { deltaText: "Hello world", replace: undefined },
        { deltaText: "Goodbye world", replace: true },
      ],
      expectedText: "Goodbye world",
    },
    {
      name: "identical snapshots from distinct assistant items",
      updates: [
        { itemId: "first", text: "Echo" },
        { itemId: "second", text: "Echo" },
      ],
      expectedDeltas: [
        { deltaText: "Echo", replace: undefined },
        { deltaText: "\n\nEcho", replace: undefined },
      ],
      expectedText: "Echo\n\nEcho",
    },
    {
      name: "a new assistant item extending an earlier item's text",
      updates: [
        { itemId: "first", text: "Echo", delta: "Echo" },
        { itemId: "second", text: "Echo!", delta: "Echo!" },
      ],
      expectedDeltas: [
        { deltaText: "Echo", replace: undefined },
        { deltaText: "\n\nEcho!", replace: undefined },
      ],
      expectedText: "Echo\n\nEcho!",
    },
    {
      name: "replayed and growing snapshots of one assistant item",
      updates: [
        { itemId: "answer", text: "Echo", delta: "Echo" },
        { itemId: "answer", text: "Echo", delta: "Echo" },
        { itemId: "answer", text: "Echo again", delta: " again" },
      ],
      expectedDeltas: [
        { deltaText: "Echo", replace: undefined },
        { deltaText: " again", replace: undefined },
      ],
      expectedText: "Echo again",
    },
    {
      name: "item-scoped deltas without snapshots",
      updates: [
        { itemId: "first", delta: "Echo" },
        { itemId: "first", delta: "Echo" },
        { itemId: "second", delta: "!" },
      ],
      expectedDeltas: [
        { deltaText: "Echo", replace: undefined },
        { deltaText: "Echo", replace: undefined },
        { deltaText: "\n\n!", replace: undefined },
      ],
      expectedText: "EchoEcho\n\n!",
    },
    {
      name: "empty corrections that remove only the current assistant item",
      updates: [
        { itemId: "first", text: "Hello" },
        { itemId: "second", text: " world" },
        { itemId: "second", text: "" },
      ],
      expectedDeltas: [
        { deltaText: "Hello", replace: undefined },
        { deltaText: "\n\n world", replace: undefined },
        { deltaText: "Hello", replace: true },
      ],
      expectedText: "Hello",
    },
    {
      name: "a failed same-item clear followed by a recovery item",
      updates: [
        { itemId: "failed", text: "Failed draft", delta: "Failed draft" },
        { itemId: "failed", text: "", delta: "", replace: true },
        { itemId: "recovery", text: "Recovered answer", delta: "Recovered answer" },
      ],
      expectedDeltas: [
        { deltaText: "Failed draft", replace: undefined },
        { deltaText: "", replace: true },
        { deltaText: "Recovered answer", replace: undefined },
      ],
      expectedText: "Recovered answer",
    },
  ])(
    "EmbeddedTuiBackend.sendChat projects $name",
    async ({ updates, expectedDeltas, expectedText }) => {
      const pending = createPendingReply();
      prepareReply(pending.promise);

      const backend = createBackend();
      const events = captureBackendEvents(backend);

      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "replace",
        runId: "run-local-replace",
      });

      for (const data of updates) {
        emitAgentEvent({ runId: "run-local-replace", stream: "assistant", data });
      }

      pending.resolve({ payloads: [], meta: {} });
      await flushMicrotasks();

      const chatPayloads = events
        .filter((entry) => entry.event === "chat")
        .map(
          (entry) =>
            entry.payload as {
              state?: string;
              deltaText?: string;
              replace?: boolean;
              message?: { content?: Array<{ text?: string }> };
            },
        );
      expect(
        chatPayloads
          .filter((payload) => payload.state === "delta")
          .map((payload) => ({
            deltaText: payload.deltaText,
            replace: payload.replace,
          })),
      ).toEqual(expectedDeltas);
      expect(chatPayloads.at(-1)).toMatchObject({
        state: "final",
        message: { content: [{ text: expectedText }] },
      });
    },
  );

  it.each(["final", "aborted"] as const)(
    "EmbeddedTuiBackend.sendChat keeps a failed clear visible before %s without exposing suppressed output",
    async (state) => {
      const pending = createPendingReply();
      prepareReply(pending.promise);
      const backend = createBackend();
      const events = captureBackendEvents(backend);
      const runId = `run-local-clear-${state}`;
      backend.start();
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "clear the failed draft",
        runId,
      });

      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { itemId: "failed", text: "Failed draft", delta: "Failed draft" },
      });
      for (const data of [
        {
          itemId: "failed",
          text: `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nprivate runtime detail\n${INTERNAL_RUNTIME_CONTEXT_END}`,
        },
        { itemId: "failed", text: "Private commentary", phase: "commentary" },
      ]) {
        emitAgentEvent({ runId, stream: "assistant", data });
      }
      expect(events.filter((entry) => entry.event === "chat")).toHaveLength(1);

      emitAgentEvent({
        runId,
        stream: "assistant",
        data: { itemId: "failed", text: "", delta: "", replace: true },
      });
      expect(
        events.filter((entry) => entry.event === "chat").map((entry) => entry.payload),
      ).toEqual([
        expect.objectContaining({ state: "delta", deltaText: "Failed draft" }),
        {
          runId,
          sessionKey: "agent:main:main",
          agentId: "main",
          state: "delta",
          deltaText: "",
          replace: true,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            timestamp: embeddedEventTimestamp,
          },
        },
      ]);

      if (state === "aborted") {
        await expect(backend.abortChat({ sessionKey: "agent:main:main", runId })).resolves.toEqual({
          ok: true,
          aborted: true,
          runIds: [runId],
        });
      }
      pending.resolve({ payloads: [], meta: state === "aborted" ? { aborted: true } : {} });
      await flushMicrotasks();

      const chatPayloads = events
        .filter((entry) => entry.event === "chat")
        .map((entry) => entry.payload);
      expect(chatPayloads).toHaveLength(3);
      expect(chatPayloads.at(-1)).toEqual({
        runId,
        sessionKey: "agent:main:main",
        agentId: "main",
        state,
      });
    },
  );
}
