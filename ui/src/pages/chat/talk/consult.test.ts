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

function createChatEvents() {
  let listener: ((event: { event: string; payload?: unknown }) => void) | undefined;
  return {
    addEventListener: vi.fn((callback: typeof listener) => {
      listener = callback;
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
