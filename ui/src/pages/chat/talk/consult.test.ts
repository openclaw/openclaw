/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
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
    reply(text: string) {
      this.final({ role: "assistant", provider: "openclaw", model: "delivery-mirror", text });
    },
    final(message?: unknown) {
      listener?.({ event: "chat", payload: { runId: "run-1", state: "final", message } });
    },
  };
}

type ConsultParams = Parameters<typeof submitRealtimeTalkConsult>[0];
function consultContext(client: object, overrides: Partial<ConsultParams["ctx"]> = {}) {
  return { client, sessionKey: "agent:main:main", callbacks: {}, ...overrides } as never;
}
function startConsult(
  ctx: ConsultParams["ctx"],
  submit: ConsultParams["submit"],
  signal?: AbortSignal,
) {
  return submitRealtimeTalkConsult({
    ctx,
    submit,
    signal,
    callId: "call-1",
    args: { question: "Check status" },
  });
}
function consultFixture(
  onStart: (events: ReturnType<typeof createChatEvents>) => void,
  wait?: () => unknown,
) {
  const events = createChatEvents();
  const submit = vi.fn();
  const request = vi.fn(async (method: string) => {
    if (method === "talk.client.toolCall") {
      onStart(events);
      return consultRun;
    }
    if (method === "agent.wait" && wait) {
      return wait();
    }
    throw new Error(`unexpected request: ${method}`);
  });
  return {
    request,
    submit,
    start: () =>
      startConsult(consultContext({ request, addEventListener: events.addEventListener }), submit),
  };
}

function steeringFixture(mode: "steer" | "cancel", suppressed = false) {
  const request = vi.fn(async () => ({
    ok: true,
    mode,
    sessionKey: "agent:main:main",
    active: true,
    ...(mode === "cancel" ? { aborted: true } : { queued: true }),
    message:
      mode === "cancel"
        ? "Cancelled the active OpenClaw run."
        : "Got it. I steered the active run.",
    speak: !suppressed,
    show: true,
    suppress: suppressed,
  }));
  return {
    request,
    ctx: consultContext({ request, addEventListener: vi.fn() }),
  };
}

describe("RealtimeTalkSession consult handoff", () => {
  afterEach(() => vi.useRealTimers());
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

    const consult = startConsult(
      consultContext({ request }, { voiceSessionId: "voice-1", flushTranscriptWrites }),
      submit,
      controller.signal,
    );
    await vi.waitFor(() => expect(flushTranscriptWrites).toHaveBeenCalledOnce());

    controller.abort();
    flushPending.resolve();
    await consult;

    expect(request).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
  });

  it.each([
    { agentSessionKey: "agent:voice:home", abortFails: false },
    { agentSessionKey: "global", abortFails: false },
    { agentSessionKey: "agent:voice:home", abortFails: true },
  ])(
    "settles cancellation for $agentSessionKey even if the abort RPC fails: $abortFails",
    async ({ agentSessionKey, abortFails }) => {
      type Acknowledgement = { runId: string; agentId: string; agentSessionKey: string };
      const pendingAcknowledgement = createDeferred<Acknowledgement>();
      const request = vi.fn(
        async (method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
          if (method === "talk.client.toolCall") {
            expect(options).toBeUndefined();
            return await pendingAcknowledgement.promise;
          }
          if (method === "chat.abort") {
            if (abortFails) {
              throw new Error("Gateway disconnected during abort");
            }
            return { ok: true, aborted: true };
          }
          throw new Error(`unexpected request: ${method}`);
        },
      );
      const submit = vi.fn();
      const controller = new AbortController();

      const consult = startConsult(
        consultContext({ request }, { sessionKey: "main" }),
        submit,
        controller.signal,
      );
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

  it.each([
    ["reply during wait", "pending", true, 251, 301, undefined],
    ["reply after wait", "ok", true, 0, 300, undefined],
    ["no-text fallback", "ok", false, 499, 500, undefined],
    ["provider error", "error", false, 0, 1, "provider authentication failed"],
    ["operator abort", "timeout", false, 0, 1, "aborted by operator"],
  ] as const)(
    "settles an empty final with %s",
    async (_name, status, reply, checkpoint, end, error) => {
      vi.useFakeTimers();
      const wait = () =>
        status === "pending"
          ? new Promise(() => {})
          : {
              runId: "run-1",
              status,
              ...(status === "timeout" ? { stopReason: "rpc" } : {}),
              ...(error ? { error } : {}),
            };
      const { request, submit, start } = consultFixture((events) => {
        window.setTimeout(() => {
          events.final();
          if (reply) {
            window.setTimeout(() => events.reply("The source reply wins."), 300);
          }
        }, 0);
      }, wait);
      const consult = start();
      if (checkpoint) {
        await vi.advanceTimersByTimeAsync(checkpoint);
        expect(submit).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(end - checkpoint);
      await consult;
      expect(request).toHaveBeenCalledWith("agent.wait", { runId: "run-1", timeoutMs: 120_000 });
      expect(submit).toHaveBeenCalledExactlyOnceWith(
        "call-1",
        error
          ? { error }
          : {
              result: reply ? "The source reply wins." : "OpenClaw finished with no text.",
            },
      );
    },
  );

  it("keeps source-reply final text when the empty-final wait completes later", async () => {
    const waitResult = createDeferred<{ runId: string; status: "ok" }>();
    const { request, submit, start } = consultFixture(
      (events) => {
        setImmediate(() => {
          events.final();
          setImmediate(() => events.reply("The source reply still wins."));
        });
      },
      () => waitResult.promise,
    );

    await start();
    waitResult.resolve({ runId: "run-1", status: "ok" });
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("agent.wait", {
      runId: "run-1",
      timeoutMs: 120_000,
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith("call-1", {
      result: "The source reply still wins.",
    });
  });

  it.each([
    ["steer", false],
    ["cancel", false],
    ["steer", true],
  ] as const)(
    "routes %s controls (suppressed: %s) and only speaks steer results",
    async (mode, suppressed) => {
      const { request, ctx } = steeringFixture(mode, suppressed);
      const speakControlResult = vi.fn();
      await steerRealtimeTalkActiveConsult({ ctx, text: "use the safer path", speakControlResult });
      expect(request).toHaveBeenCalledWith("talk.client.steer", {
        sessionKey: "agent:main:main",
        text: "use the safer path",
      });
      if (mode === "cancel") {
        expect(speakControlResult).not.toHaveBeenCalled();
      } else {
        expect(speakControlResult).toHaveBeenCalledWith(
          expect.stringContaining('Status: "Got it. I steered the active run."'),
        );
      }
    },
  );
});
