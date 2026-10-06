/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { steerRealtimeTalkActiveConsult, submitRealtimeTalkConsult } from "./shared.ts";

const consultRun = {
  runId: "run-1",
  idempotencyKey: "run-1",
  agentId: "main",
  agentSessionKey: "agent:main:main",
};

function createChatEvents(expectedSubscribers = 1) {
  let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
  let subscribers = 0;
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  // Settles once `count` consult calls are waiting for their result, so a test can cancel from a known state.
  const subscribed = (count: number) =>
    new Promise<void>((resolve) => {
      if (subscribers >= count) {
        resolve();
      } else {
        waiters.push({ count, resolve });
      }
    });
  return {
    subscribed,
    get allSubscribed() {
      return subscribed(expectedSubscribers);
    },
    addEventListener: vi.fn((callback: typeof listener) => {
      listener = callback;
      subscribers += 1;
      for (const waiter of waiters) {
        if (subscribers >= waiter.count) {
          waiter.resolve();
        }
      }
      return () => {
        listener = undefined;
      };
    }),
    emit(payload: unknown) {
      listener?.({ event: "chat", payload });
    },
    final(message?: unknown) {
      listener?.({ event: "chat", payload: { runId: "run-1", state: "final", message } });
    },
  };
}

describe("RealtimeTalkSession consult handoff", () => {
  it("submits realtime consults through the Gateway tool-call endpoint", async () => {
    const order: string[] = [];
    const events = createChatEvents();
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "talk.client.toolCall") {
        order.push("tool-call");
        setImmediate(() => {
          events.final({ text: "Basement lights are off." });
        });
        return consultRun;
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const submit = vi.fn();
    const flushTranscriptWrites = vi.fn(async () => {
      order.push("flush");
    });

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener: events.addEventListener },
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-1",
        flushTranscriptWrites,
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Are the basement lights off?" },
      submit,
    });

    expect(request).toHaveBeenCalledWith("talk.client.toolCall", {
      sessionKey: "agent:main:main",
      voiceSessionId: "voice-1",
      name: "openclaw_agent_consult",
      callId: "call-1",
      args: { question: "Are the basement lights off?" },
    });
    expect(submit).toHaveBeenCalledWith("call-1", { result: "Basement lights are off." });
    expect(order).toEqual(["flush", "tool-call"]);
  });

  it("does not start a consult after aborting during the transcript flush", async () => {
    const flushPending = createDeferred();
    const flushTranscriptWrites = vi.fn(async () => await flushPending.promise);
    const request = vi.fn();
    const submit = vi.fn();
    const controller = new AbortController();

    const consult = submitRealtimeTalkConsult({
      ctx: {
        client: { request },
        sessionKey: "agent:main:main",
        voiceSessionId: "voice-1",
        flushTranscriptWrites,
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Check status" },
      submit,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(flushTranscriptWrites).toHaveBeenCalledOnce());

    controller.abort();
    flushPending.resolve();
    await consult;

    expect(request).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("does not abort a run another consult call is still waiting on", async () => {
    const events = createChatEvents(2);
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { runId: "shared-run", agentId: "main", agentSessionKey: "agent:main:main" };
      }
      return { ok: true };
    });
    const ctx = {
      client: { request, addEventListener: events.addEventListener },
      sessionKey: "main",
      callbacks: {},
    } as never;
    const first = new AbortController();
    const second = new AbortController();
    const start = (callId: string, signal: AbortSignal) =>
      submitRealtimeTalkConsult({
        ctx,
        callId,
        args: { question: "Check" },
        submit: vi.fn(),
        signal,
      });
    const a = start("call-a", first.signal);
    const b = start("call-b", second.signal);
    const toolCalls = () => request.mock.calls.filter(([m]) => m === "talk.client.toolCall");
    const aborts = () => request.mock.calls.filter(([m]) => m === "chat.abort");
    await events.allSubscribed;
    expect(toolCalls()).toHaveLength(2);

    first.abort();
    await a;
    expect(aborts()).toHaveLength(0);

    second.abort();
    await b;
    expect(aborts()).toHaveLength(1);
  });

  describe("a repeat that is still awaiting its acknowledgement", () => {
    type Ack = { runId: string; agentId: string; agentSessionKey: string };
    const ackFor = (runId: string): Ack => ({
      runId,
      agentId: "main",
      agentSessionKey: "agent:main:main",
    });
    // Call 1 is acknowledged at once; call 2 stays unacknowledged until the test settles it.
    function setup() {
      const events = createChatEvents();
      let resolveSecond!: (ack: Ack) => void;
      let rejectSecond!: (error: Error) => void;
      let toolCalls = 0;
      let markSecondRequested!: () => void;
      const secondRequested = new Promise<void>((resolve) => {
        markSecondRequested = resolve;
      });
      const request = vi.fn(async (method: string) => {
        if (method !== "talk.client.toolCall") {
          return { ok: true };
        }
        toolCalls += 1;
        if (toolCalls === 1) {
          return ackFor("run-x");
        }
        markSecondRequested();
        return await new Promise<Ack>((resolve, reject) => {
          resolveSecond = resolve;
          rejectSecond = reject;
        });
      });
      const ctx = {
        client: { request, addEventListener: events.addEventListener },
        sessionKey: "main",
        callbacks: {},
      } as never;
      const first = new AbortController();
      const second = new AbortController();
      const start = (callId: string, signal: AbortSignal, args: unknown = { question: "Check" }) =>
        submitRealtimeTalkConsult({ ctx, callId, args, submit: vi.fn(), signal });
      const aborts = () =>
        request.mock.calls
          .filter(([method]) => method === "chat.abort")
          .map((call) => (call as unknown as [string, { runId: string }])[1]);
      return {
        events,
        first,
        second,
        start,
        aborts,
        resolveSecond: (ack: Ack) => resolveSecond(ack),
        rejectSecond: (error: Error) => rejectSecond(error),
        secondRequested,
      };
    }

    it("keeps the run when the repeat then joins it", async () => {
      const t = setup();
      const a = t.start("call-a", t.first.signal);
      await t.events.subscribed(1);
      const b = t.start("call-b", t.second.signal);
      await t.secondRequested;
      t.first.abort();
      await a;
      expect(t.aborts()).toEqual([]);
      t.resolveSecond(ackFor("run-x"));
      await t.events.subscribed(2);
      expect(t.aborts()).toEqual([]);
      t.second.abort();
      await b;
      expect(t.aborts()).toEqual([expect.objectContaining({ runId: "run-x" })]);
    });

    it("holds the abort for an equivalent repeat written with an alias and another field order", async () => {
      const t = setup();
      const a = t.start("call-a", t.first.signal, { question: "Check", context: "kitchen" });
      await t.events.subscribed(1);
      const b = t.start("call-b", t.second.signal, { context: "kitchen", prompt: "Check" });
      await t.secondRequested;
      t.first.abort();
      await a;
      expect(t.aborts()).toEqual([]);
      t.resolveSecond(ackFor("run-x"));
      await t.events.subscribed(2);
      expect(t.aborts()).toEqual([]);
      t.second.abort();
      await b;
      expect(t.aborts()).toEqual([expect.objectContaining({ runId: "run-x" })]);
    });

    it("aborts the held run when the repeat starts a different run", async () => {
      const t = setup();
      const a = t.start("call-a", t.first.signal);
      await t.events.subscribed(1);
      const b = t.start("call-b", t.second.signal);
      await t.secondRequested;
      t.first.abort();
      await a;
      expect(t.aborts()).toEqual([]);
      t.resolveSecond(ackFor("run-y"));
      await t.events.subscribed(2);
      expect(t.aborts()).toEqual([expect.objectContaining({ runId: "run-x" })]);
      t.second.abort();
      await b;
      expect(t.aborts().map((params) => params.runId)).toEqual(["run-x", "run-y"]);
    });

    it("aborts the held run when the repeat fails before it is acknowledged", async () => {
      const t = setup();
      const a = t.start("call-a", t.first.signal);
      await t.events.subscribed(1);
      const b = t.start("call-b", t.second.signal);
      await t.secondRequested;
      t.first.abort();
      await a;
      expect(t.aborts()).toEqual([]);
      t.rejectSecond(new Error("gateway unavailable"));
      await b;
      expect(t.aborts()).toEqual([expect.objectContaining({ runId: "run-x" })]);
    });
  });

  it("aborts a shared run once when every waiting consult call is cancelled in the same tick", async () => {
    const events = createChatEvents(2);
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { runId: "shared-run-sync", agentId: "main", agentSessionKey: "agent:main:main" };
      }
      return { ok: true };
    });
    const ctx = {
      client: { request, addEventListener: events.addEventListener },
      sessionKey: "main",
      callbacks: {},
    } as never;
    const controllers = [new AbortController(), new AbortController()];
    const consults = controllers.map((controller, index) =>
      submitRealtimeTalkConsult({
        ctx,
        callId: `call-${index}`,
        args: { question: "Check" },
        submit: vi.fn(),
        signal: controller.signal,
      }),
    );
    const count = (name: string) => request.mock.calls.filter(([m]) => m === name).length;
    await events.allSubscribed;
    expect(count("talk.client.toolCall")).toBe(2);

    for (const controller of controllers) {
      controller.abort();
    }
    await Promise.all(consults);
    expect(count("chat.abort")).toBe(1);
  });

  it.each(["agent:voice:home", "global"])(
    "keeps the acknowledgement alive and cancels its exact %s target",
    async (agentSessionKey) => {
      type Acknowledgement = { runId: string; agentId: string; agentSessionKey: string };
      const pendingAcknowledgement = createDeferred<Acknowledgement>();
      const request = vi.fn(
        async (method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
          if (method === "talk.client.toolCall") {
            expect(options).toBeUndefined();
            return await pendingAcknowledgement.promise;
          }
          if (method === "chat.abort") {
            return { ok: true, aborted: true };
          }
          throw new Error(`unexpected request: ${method}`);
        },
      );
      const submit = vi.fn();
      const controller = new AbortController();

      const consult = submitRealtimeTalkConsult({
        ctx: {
          client: { request },
          sessionKey: "main",
          callbacks: {},
        } as never,
        callId: "call-1",
        args: { question: "Check status" },
        submit,
        signal: controller.signal,
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

      controller.abort();
      pendingAcknowledgement.resolve({ runId: "run-1", agentId: "voice", agentSessionKey });
      await consult;

      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey: agentSessionKey,
        agentId: "voice",
        runId: "run-1",
      });
      expect(submit).toHaveBeenCalledOnce();
    },
  );

  it("waits past the old empty-final grace window for delayed source-reply final text", async () => {
    vi.useFakeTimers();
    try {
      const events = createChatEvents();
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.toolCall") {
          window.setTimeout(() => {
            events.final();
            window.setTimeout(() => {
              events.final({
                role: "assistant",
                provider: "openclaw",
                model: "delivery-mirror",
                text: "The slow source reply wins.",
              });
            }, 300);
          }, 0);
          return consultRun;
        }
        if (method === "agent.wait") {
          return new Promise(() => {});
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const submit = vi.fn();

      const consult = submitRealtimeTalkConsult({
        ctx: {
          client: { request, addEventListener: events.addEventListener },
          sessionKey: "agent:main:main",
          callbacks: {},
        } as never,
        callId: "call-1",
        args: { question: "Check status" },
        submit,
      });

      await vi.advanceTimersByTimeAsync(251);
      expect(submit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      await consult;

      expect(submit).toHaveBeenCalledWith("call-1", {
        result: "The slow source reply wins.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps source-reply final text when the empty-final wait completes later", async () => {
    const events = createChatEvents();
    const waitResult = createDeferred<{ runId: string; status: "ok" }>();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          events.final();
          setImmediate(() => {
            events.final({
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              text: "The source reply still wins.",
            });
          });
        });
        return consultRun;
      }
      if (method === "agent.wait") {
        return await waitResult.promise;
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const submit = vi.fn();

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener: events.addEventListener },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Check status" },
      submit,
    });
    waitResult.resolve({ runId: "run-1", status: "ok" });
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("agent.wait", {
      runId: "run-1",
      timeoutMs: 120_000,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("call-1", {
      result: "The source reply still wins.",
    });
  });

  it("keeps source-reply final text when the empty-final wait completes first", async () => {
    vi.useFakeTimers();
    try {
      const events = createChatEvents();
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.toolCall") {
          window.setTimeout(() => {
            events.final();
            window.setTimeout(() => {
              events.final({
                role: "assistant",
                provider: "openclaw",
                model: "delivery-mirror",
                text: "The source reply beats the fallback.",
              });
            }, 300);
          }, 0);
          return consultRun;
        }
        if (method === "agent.wait") {
          return { runId: "run-1", status: "ok" };
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const submit = vi.fn();

      const consult = submitRealtimeTalkConsult({
        ctx: {
          client: { request, addEventListener: events.addEventListener },
          sessionKey: "agent:main:main",
          callbacks: {},
        } as never,
        callId: "call-1",
        args: { question: "Check status" },
        submit,
      });

      await vi.advanceTimersByTimeAsync(300);
      await consult;

      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith("call-1", {
        result: "The source reply beats the fallback.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("submits the no-text fallback after an empty final and completed Gateway run", async () => {
    vi.useFakeTimers();
    try {
      let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
      const request = vi.fn(async (method: string) => {
        if (method === "talk.client.toolCall") {
          window.setTimeout(() => {
            listener?.({
              event: "chat",
              payload: {
                runId: "run-1",
                state: "final",
                message: undefined,
              },
            });
          }, 0);
          return {
            runId: "run-1",
            idempotencyKey: "run-1",
            agentId: "main",
            agentSessionKey: "agent:main:main",
          };
        }
        if (method === "agent.wait") {
          return { runId: "run-1", status: "ok" };
        }
        throw new Error(`unexpected request: ${method}`);
      });
      const addEventListener = vi.fn((callback: typeof listener) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      });
      const submit = vi.fn();

      const consult = submitRealtimeTalkConsult({
        ctx: {
          client: { request, addEventListener },
          sessionKey: "agent:main:main",
          callbacks: {},
        } as never,
        callId: "call-1",
        args: { question: "Check status" },
        submit,
      });

      await vi.advanceTimersByTimeAsync(499);
      expect(submit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await consult;

      expect(request).toHaveBeenCalledWith("agent.wait", {
        runId: "run-1",
        timeoutMs: 120_000,
      });
      expect(submit).toHaveBeenCalledWith("call-1", {
        result: "OpenClaw finished with no text.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      waitResult: { runId: "run-1", status: "error", error: "provider authentication failed" },
      expected: "provider authentication failed",
    },
    {
      waitResult: {
        runId: "run-1",
        status: "timeout",
        stopReason: "rpc",
        error: "aborted by operator",
      },
      expected: "aborted by operator",
    },
  ])("submits $expected from terminal empty-final waits", async ({ waitResult, expected }) => {
    const events = createChatEvents();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          events.final();
        });
        return consultRun;
      }
      if (method === "agent.wait") {
        return waitResult;
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const submit = vi.fn();

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener: events.addEventListener },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Check status" },
      submit,
    });

    expect(submit).toHaveBeenCalledWith("call-1", { error: expected });
  });

  it("emits Talk progress from chat tool events while waiting for the consult result", async () => {
    const events = createChatEvents();
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        setImmediate(() => {
          events.emit({
            runId: "run-1",
            stream: "tool",
            data: { phase: "start", name: "read", toolCallId: "tool-1" },
          });
          events.final({ text: "Done." });
        });
        return consultRun;
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const emitTalkEvent = vi.fn();

    await submitRealtimeTalkConsult({
      ctx: {
        client: { request, addEventListener: events.addEventListener },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      callId: "call-1",
      args: { question: "Check files" },
      submit: vi.fn(),
      emitTalkEvent,
    });

    expect(emitTalkEvent).toHaveBeenCalledWith({
      type: "tool.progress",
      callId: "tool-1",
      payload: { runId: "run-1", name: "read", phase: "start" },
    });
  });

  it("routes active consult steering through Gateway control endpoints", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      active: true,
      queued: true,
      message: "Got it. I steered the active run.",
      speak: true,
      show: true,
      suppress: false,
    }));
    const emitTalkEvent = vi.fn();

    await steerRealtimeTalkActiveConsult({
      ctx: {
        client: { request, addEventListener: vi.fn() },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      text: "use the safer path",
      emitTalkEvent,
    });

    expect(request).toHaveBeenCalledWith("talk.client.steer", {
      sessionKey: "agent:main:main",
      text: "use the safer path",
    });
    expect(emitTalkEvent).toHaveBeenCalledWith({
      type: "tool.progress",
      payload: {
        name: "openclaw_agent_control",
        result: expect.objectContaining({ mode: "steer" }),
      },
      final: false,
    });
  });

  it("can suppress cancel control speech while the original consult submits the cancel result", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      mode: "cancel",
      sessionKey: "agent:main:main",
      active: true,
      aborted: true,
      message: "Cancelled the active OpenClaw run.",
      speak: true,
      show: true,
      suppress: false,
    }));
    const speakControlResult = vi.fn();

    await steerRealtimeTalkActiveConsult({
      ctx: {
        client: { request, addEventListener: vi.fn() },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      text: "cancel that",
      speakControlResult,
      suppressSpeechForModes: ["cancel"],
    });

    expect(request).toHaveBeenCalledWith("talk.client.steer", {
      sessionKey: "agent:main:main",
      text: "cancel that",
    });
    expect(speakControlResult).not.toHaveBeenCalled();
  });

  it("speaks legacy suppressed steer acknowledgements instead of leaving voice silent", async () => {
    const request = vi.fn(async () => ({
      ok: true,
      mode: "steer",
      sessionKey: "agent:main:main",
      active: true,
      queued: true,
      message: "Got it. I steered the active run.",
      speak: false,
      show: true,
      suppress: true,
    }));
    const speakControlResult = vi.fn();

    await steerRealtimeTalkActiveConsult({
      ctx: {
        client: { request, addEventListener: vi.fn() },
        sessionKey: "agent:main:main",
        callbacks: {},
      } as never,
      text: "use the safer path",
      speakControlResult,
    });

    expect(speakControlResult).toHaveBeenCalledWith(
      expect.stringContaining('Status: "Got it. I steered the active run."'),
    );
  });
});
