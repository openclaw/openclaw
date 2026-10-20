import { expect, it, onTestFinished, vi, type Mock } from "vitest";
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
import {
  deferred,
  flushMicrotasks,
  localSessionEntry,
  sendMainChat,
} from "./embedded-backend.test-helpers.js";

export function pendingReply(mock: Mock, onStart?: (signal?: AbortSignal) => void) {
  const pending = deferred<EmbeddedAgentResult>();
  if (onStart) {
    mock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      onStart(opts.abortSignal);
      return pending.promise;
    });
  } else {
    mock.mockReturnValueOnce(pending.promise);
  }
  return pending;
}

export function mockLocalSession(
  mock: Mock<typeof localSessionEntry>,
  overrides: () => Parameters<typeof localSessionEntry>[2],
) {
  mock.mockImplementation((key, opts) => localSessionEntry(key, opts, overrides()));
}

export async function expectAgentCall(
  mock: Mock,
  count: number,
  expected: Record<string, unknown>,
) {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
  expect(mock.mock.calls[count - 1]?.[0]).toMatchObject(expected);
}

type ChatPayload = {
  state?: string;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
};

export function getChatPayloads(events: Array<{ event: string; payload: unknown }>) {
  return events
    .filter((event) => event.event === "chat")
    .map((event) => event.payload as ChatPayload);
}

export function agentResult(text?: string, meta: Record<string, unknown> = {}) {
  return { payloads: text === undefined ? [] : [{ text }], meta };
}

export function assistantMessage(text: string, timestamp: number) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

export function mainChatEvent(runId: string, payload: Record<string, unknown>) {
  return {
    event: "chat",
    payload: { runId, sessionKey: "agent:main:main", agentId: "main", ...payload },
  };
}

export function startBackend(createBackend: () => EmbeddedTuiBackend) {
  const backend = createBackend();
  const events = captureBackendEvents(backend);
  backend.start();
  return { backend, events };
}

function displayDelta(deltaText: string, replace?: boolean) {
  return { deltaText, replace };
}

export function captureBackendEvents(backend: EmbeddedTuiBackend) {
  const events: Array<{ event: string; payload: unknown }> = [];
  backend.onEvent = ({ event, payload }) => {
    events.push({ event, payload });
  };
  return events;
}

export type EmbeddedAgentResult = ReturnType<typeof agentResult>;

type StreamTestContext = {
  createBackend: () => EmbeddedTuiBackend;
  prepareReply: (
    reply: Promise<EmbeddedAgentResult>,
    onStart?: (signal: AbortSignal) => void,
  ) => void;
  emitAgentEvent: (event: unknown) => void;
  embeddedEventTimestamp: number;
};

export function registerEmbeddedBackendStreamTests({
  createBackend,
  prepareReply,
  emitAgentEvent,
  embeddedEventTimestamp,
}: StreamTestContext) {
  const emitRun = (runId: string, stream: string, data: unknown) =>
    emitAgentEvent({ runId, stream, data });
  async function startStream(
    message: string,
    runId: string,
    onStart?: (signal: AbortSignal) => void,
  ) {
    const pending = deferred<EmbeddedAgentResult>();
    prepareReply(pending.promise, onStart);
    const { backend, events } = startBackend(createBackend);
    await sendMainChat(backend, message, runId);
    return { pending, backend, events };
  }
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
      const started = deferred<AbortSignal>();
      const runId = `local-cancel-${method}-${wait}`;
      const sessionKey = "agent:main:main";
      registerAgentRunContext(runId, { sessionKey });
      onTestFinished(() => clearAgentRunContext(runId));
      const context = getAgentRunContext(runId);
      if (!context) {
        throw new Error("Expected the test run to be registered");
      }
      const { pending, backend, events } = await startStream("long task", runId, (signal) => {
        signal.addEventListener("abort", () => delete context.localModelWait, { once: true });
        started.resolve(signal);
      });
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
      pending.resolve(agentResult(undefined, { aborted: true }));
      await flushMicrotasks();
      expect(events.filter((event) => event.event === "chat")).toEqual([
        mainChatEvent(runId, {
          state: "aborted",
          ...(caveat ? { localModelMayStillBeFinishing: true } : {}),
        }),
      ]);
    },
  );

  it("paces display deltas and flushes them before tools, corrections, and completion", async () => {
    const runId = "run-local-paced";
    const { pending, events } = await startStream("pace text", runId);
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
    emitRun(runId, "tool", { phase: "start", name: "exec" });
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
    ).toMatchObject([{ deltaText: " discarded" }, displayDelta("Corrected", true)]);

    append(" final");
    pending.resolve(agentResult(undefined));
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
    const { pending, events } = await startStream(
      "split internal context",
      "run-local-split-context",
    );

    const deltas = [
      `Visible\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n`,
      "private runtime detail\n",
      `${INTERNAL_RUNTIME_CONTEXT_END}\nAfter`,
    ];
    deltas.forEach((delta) => {
      emitRun("run-local-split-context", "assistant", { delta });
    });
    emitRun("run-local-split-context", "lifecycle", { phase: "end", stopReason: "stop" });
    pending.resolve(agentResult("Visible\n\nAfter"));
    await flushMicrotasks();

    const chatPayloads = getChatPayloads(events);
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
      expectedDeltas: [displayDelta("Hello world"), displayDelta("Goodbye world", true)],
      expectedText: "Goodbye world",
    },
    {
      name: "identical snapshots from distinct assistant items",
      updates: [
        { itemId: "first", text: "Echo" },
        { itemId: "second", text: "Echo" },
      ],
      expectedDeltas: [displayDelta("Echo"), displayDelta("\n\nEcho")],
      expectedText: "Echo\n\nEcho",
    },
    {
      name: "a new assistant item extending an earlier item's text",
      updates: [
        { itemId: "first", text: "Echo", delta: "Echo" },
        { itemId: "second", text: "Echo!", delta: "Echo!" },
      ],
      expectedDeltas: [displayDelta("Echo"), displayDelta("\n\nEcho!")],
      expectedText: "Echo\n\nEcho!",
    },
    {
      name: "replayed and growing snapshots of one assistant item",
      updates: [
        { itemId: "answer", text: "Echo", delta: "Echo" },
        { itemId: "answer", text: "Echo", delta: "Echo" },
        { itemId: "answer", text: "Echo again", delta: " again" },
      ],
      expectedDeltas: [displayDelta("Echo"), displayDelta(" again")],
      expectedText: "Echo again",
    },
    {
      name: "item-scoped deltas without snapshots",
      updates: [
        { itemId: "first", delta: "Echo" },
        { itemId: "first", delta: "Echo" },
        { itemId: "second", delta: "!" },
      ],
      expectedDeltas: [displayDelta("Echo"), displayDelta("Echo"), displayDelta("\n\n!")],
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
        displayDelta("Hello"),
        displayDelta("\n\n world"),
        displayDelta("Hello", true),
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
        displayDelta("Failed draft"),
        displayDelta("", true),
        displayDelta("Recovered answer"),
      ],
      expectedText: "Recovered answer",
    },
  ])(
    "EmbeddedTuiBackend.sendChat projects $name",
    async ({ updates, expectedDeltas, expectedText }) => {
      const { pending, events } = await startStream("replace", "run-local-replace");

      for (const data of updates) {
        emitRun("run-local-replace", "assistant", data);
      }

      pending.resolve(agentResult(undefined));
      await flushMicrotasks();

      const chatPayloads = getChatPayloads(events);
      expect(
        chatPayloads
          .filter((payload) => payload.state === "delta")
          .map((payload) => ({ deltaText: payload.deltaText, replace: payload.replace })),
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
      const runId = `run-local-clear-${state}`;
      const { pending, backend, events } = await startStream("clear the failed draft", runId);

      emitRun(runId, "assistant", {
        itemId: "failed",
        text: "Failed draft",
        delta: "Failed draft",
      });
      for (const data of [
        {
          itemId: "failed",
          text: `${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nprivate runtime detail\n${INTERNAL_RUNTIME_CONTEXT_END}`,
        },
        { itemId: "failed", text: "Private commentary", phase: "commentary" },
      ]) {
        emitRun(runId, "assistant", data);
      }
      expect(events.filter((entry) => entry.event === "chat")).toHaveLength(1);

      emitRun(runId, "assistant", { itemId: "failed", text: "", delta: "", replace: true });
      expect(getChatPayloads(events)).toEqual([
        expect.objectContaining({ state: "delta", deltaText: "Failed draft" }),
        mainChatEvent(runId, {
          state: "delta",
          deltaText: "",
          replace: true,
          message: assistantMessage("", embeddedEventTimestamp),
        }).payload,
      ]);

      if (state === "aborted") {
        await expect(backend.abortChat({ sessionKey: "agent:main:main", runId })).resolves.toEqual({
          ok: true,
          aborted: true,
          runIds: [runId],
        });
      }
      pending.resolve(agentResult(undefined, state === "aborted" ? { aborted: true } : {}));
      await flushMicrotasks();

      const chatPayloads = getChatPayloads(events);
      expect(chatPayloads).toHaveLength(3);
      expect(chatPayloads.at(-1)).toEqual(mainChatEvent(runId, { state }).payload);
    },
  );
}
