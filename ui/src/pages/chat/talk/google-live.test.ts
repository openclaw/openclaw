import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import { consultRunResult } from "./consult.test-support.ts";
import {
  audioContexts,
  beginTransport,
  createClient,
  createdSources,
  createSession,
  createTransport,
  encodeJsonFrame,
  flushMicrotasks,
  getGoogleLiveToolOwnerState,
  googleLiveTestFixture,
  inputProcessors,
  inputSinks,
  installGoogleLiveTestFixture,
  latestWebSocket,
  pumpMicrophone,
  startTransport,
  wsInstances,
} from "./google-live.test-support.ts";
import { GoogleLiveRealtimeTalkTransport } from "./google-live.ts";
import { prepareRealtimeTalkTestInput } from "./input.test-support.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "./shared.ts";
import type { RealtimeTalkTransportContext } from "./shared.ts";

function consultCall(id: string, args: unknown) {
  return { id, name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME, args };
}

function createListeners() {
  const listeners = new Set<(event: { event: string; payload?: unknown }) => void>();
  const addEventListener = vi.fn(
    (listener: (event: { event: string; payload?: unknown }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  );
  return { listeners, addEventListener };
}

async function sessionTransport(
  session: ConstructorParameters<typeof GoogleLiveRealtimeTalkTransport>[0],
  client = createClient(),
) {
  return new GoogleLiveRealtimeTalkTransport(session, {
    input: await prepareRealtimeTalkTestInput(),
    callbacks: {},
    client,
    sessionKey: "main",
  });
}

function abortTarget(runId: string) {
  return { sessionKey: "agent:main:main", agentId: "main", runId };
}
function hasToolResponse(ws: ReturnType<typeof latestWebSocket>, id: string) {
  return ws.sent
    .map((payload) => JSON.parse(payload))
    .some((payload) => payload.toolResponse?.functionResponses?.[0]?.id === id);
}

async function startFixture(...args: Parameters<typeof createTransport>) {
  const transport = await createTransport(...args);
  return { transport, ws: await startTransport(transport) };
}

function cancelCall(ws: ReturnType<typeof latestWebSocket>, id: string) {
  ws.emitMessage(encodeJsonFrame({ toolCallCancellation: { ids: [id] } }));
}

describe("GoogleLiveRealtimeTalkTransport", () => {
  installGoogleLiveTestFixture();

  it("connects only to the allowlisted endpoint with the ephemeral token", async () => {
    const transport = await sessionTransport(
      createSession(
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?ignored=1",
      ),
    );

    const { start } = await beginTransport(transport);

    expect(latestWebSocket().url).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fbrowser-session",
    );
    transport.stop();
    await expect(start).resolves.toBe("cancelled");
  });

  it.each([
    "ws://generativelanguage.googleapis.com/ws/google.ai",
    "wss://attacker.test/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
    "wss://generativelanguage.googleapis.com/evil",
  ])("rejects attacker-controlled WebSocket URL %s", async (websocketUrl) => {
    const transport = await sessionTransport(createSession(websocketUrl));

    await expect(transport.start()).rejects.toThrow(/wss:\/\/|Untrusted Google Live WebSocket/u);
    expect(wsInstances).toHaveLength(0);
  });

  it("keeps the microphone processor inaudible locally", async () => {
    const transport = await createTransport();

    await startTransport(transport);

    const processor = inputProcessors.at(-1);
    const sink = inputSinks.at(-1);
    if (!processor || !sink) {
      throw new Error("missing microphone capture graph");
    }
    expect(sink.gain.value).toBe(0);
    expect(processor.connect).toHaveBeenCalledWith(sink);
    expect(sink.connect).toHaveBeenCalledOnce();

    transport.stop();
    expect(sink.disconnect).toHaveBeenCalledOnce();
  });

  it("requests ArrayBuffer frames and decodes binary setup messages", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ onStatus, onTalkEvent });

    const { start, ws } = await beginTransport(transport);
    onStatus.mockClear();
    ws.emitOpen();
    ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));
    await expect(start).resolves.toBe("ready");

    expect(ws.binaryType).toBe("arraybuffer");
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    transport.activate();
    transport.activate();
    expect(onStatus).toHaveBeenCalledExactlyOnceWith("listening");
    expect(onTalkEvent).toHaveBeenCalledExactlyOnceWith({ type: "session.ready" });
  });

  it("closes Google audio and its socket when the microphone ends", async () => {
    const track = Object.assign(new EventTarget(), { stop: vi.fn() });
    googleLiveTestFixture.getUserMedia.mockResolvedValueOnce({ getTracks: () => [track] });
    const onStatus = vi.fn();
    const { transport, ws } = await startFixture({ onStatus });

    track.dispatchEvent(new Event("ended"));

    expect(onStatus).toHaveBeenLastCalledWith("error", expect.stringContaining("Microphone"));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(ws.readyState).toBe(3);
    expect(inputProcessors[0]?.onaudioprocess).toBeNull();
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
    transport.stop();
  });

  it.each([
    ["close", "Realtime connection closed"],
    ["error then close", "Realtime connection failed"],
  ])("releases media on %s and ignores late frames", async (event, detail) => {
    const onStatus = vi.fn();
    const onTranscript = vi.fn();
    const { ws } = await startFixture({ onStatus, onTranscript });
    pumpMicrophone(new Float32Array(4096));
    onStatus.mockClear();
    if (event === "error then close") {
      ws.emitError();
    }
    ws.emitClose();
    expect(onStatus).toHaveBeenCalledExactlyOnceWith("error", detail);
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    expect(inputProcessors.at(-1)?.disconnect).toHaveBeenCalledOnce();
    expect(audioContexts).toHaveLength(2);
    for (const context of audioContexts) {
      expect(context.close).toHaveBeenCalledOnce();
    }
    ws.emitContent({ inputTranscription: { text: "too late", finished: true } });
    await flushMicrotasks();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it.each(["status", "talk event"] as const)(
    "releases socket resources when the terminal %s callback throws",
    async (callbackKind) => {
      const transport = await createTransport(
        callbackKind === "status"
          ? {
              onStatus: vi.fn((status) => {
                if (status === "error") {
                  throw new Error("consumer failed");
                }
              }),
            }
          : {
              onTalkEvent: vi.fn((event) => {
                if (event.type === "session.closed") {
                  throw new Error("consumer failed");
                }
              }),
            },
      );

      const ws = await startTransport(transport);
      expect(() => ws.emitError()).toThrow("consumer failed");

      expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
      expect(inputProcessors.at(-1)?.disconnect).toHaveBeenCalledOnce();
      for (const context of audioContexts) {
        expect(context.close).toHaveBeenCalledOnce();
      }
      ws.emitClose();
    },
  );

  it("finishes cleanup when the input-level callback throws during activation", async () => {
    const onInputLevel = vi.fn(() => {
      throw new Error("meter callback failed");
    });
    const transport = await createTransport({ onInputLevel });
    const { start, ws } = await beginTransport(transport);
    ws.emitOpen();
    ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));
    await expect(start).resolves.toBe("ready");

    expect(() => transport.activate()).toThrow("meter callback failed");
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    expect(inputProcessors).toHaveLength(0);
    expect(ws.readyState).toBe(3);
    for (const context of audioContexts) {
      expect(context.close).toHaveBeenCalledOnce();
    }
  });

  it("stops queued output when Google Live sends interruption", async () => {
    const { ws } = await startFixture();

    ws.emitContent({
      modelTurn: {
        parts: [{ inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } }],
      },
    });
    await waitForFast(() => expect(createdSources).toHaveLength(1));

    const source = createdSources[0];
    ws.emitContent({ interrupted: true });

    await waitForFast(() => expect(source?.stop).toHaveBeenCalledTimes(1));
  });

  it("closes an overflowing playback response and ignores late provider audio", async () => {
    const onStatus = vi.fn();
    const { ws } = await startFixture({ onStatus });

    ws.emitContent({
      modelTurn: {
        parts: Array.from({ length: 4_097 }, () => ({
          inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" },
        })),
      },
    });

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Realtime Talk playback exceeded the browser audio buffer limit",
      ),
    );
    expect(createdSources).toHaveLength(4_096);
    expect(createdSources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
    expect(ws.readyState).toBe(3);

    ws.emitContent({
      modelTurn: {
        parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }],
      },
    });
    await flushMicrotasks();
    expect(createdSources).toHaveLength(4_096);
  });

  it("rejects an oversized first frame before decoding provider audio", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const ws = await startTransport(transport);

    ws.emitMessage(
      encodeJsonFrame({
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  data: "!".repeat(3_904_000),
                  mimeType: "audio/pcm;rate=24000",
                },
              },
            ],
          },
        },
      }),
    );

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Realtime Talk playback exceeded the browser audio buffer limit",
      ),
    );
    expect(createdSources).toHaveLength(0);
    expect(ws.readyState).toBe(3);
  });

  it("publishes transcripts and plays Google Live audio frames", async () => {
    const onTranscript = vi.fn();
    const { ws } = await startFixture({ onTranscript });
    ws.emitContent({
      inputTranscription: { text: "hello", finished: true },
      outputTranscription: { text: "hi", finished: false },
      modelTurn: {
        parts: [
          { inlineData: { data: "AAAAAA==", mimeType: "audio/pcm;rate=24000" } },
          { text: "there" },
        ],
      },
      turnComplete: true,
    });

    await waitForFast(() =>
      expect(onTranscript).toHaveBeenLastCalledWith({ role: "assistant", text: "hi", final: true }),
    );
    expect(onTranscript).toHaveBeenCalledWith({ role: "user", text: "hello", final: true });
    expect(onTranscript).toHaveBeenCalledWith({ role: "assistant", text: "hi", final: false });
    expect(onTranscript).toHaveBeenLastCalledWith({ role: "assistant", text: "hi", final: true });
    expect(onTranscript).toHaveBeenCalledTimes(3);
    expect(createdSources).toHaveLength(1);
  });

  it("stops processing the current provider message when a transcript callback closes it", async () => {
    const onTalkEvent = vi.fn();
    const onTranscript = vi.fn(() => transport.stop());
    const { transport, ws } = await startFixture({ onTalkEvent, onTranscript });
    onTalkEvent.mockClear();
    ws.emitContent({
      inputTranscription: { text: "overflow", finished: true },
      outputTranscription: { text: "too late", finished: true },
      turnComplete: true,
    });
    await flushMicrotasks();

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
  });

  it("silently disposes a provisional Google Live transport", async () => {
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ onTalkEvent });
    const { start, ws } = await beginTransport(transport);

    transport.stop({ emitClosed: false });
    await expect(start).resolves.toBe("cancelled");

    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(3);
  });

  it("ignores late WebSocket events after stop", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const { start, ws } = await beginTransport(transport);
    onStatus.mockClear();

    transport.stop();
    await expect(start).resolves.toBe("cancelled");
    ws.emitOpen();
    ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));

    await flushMicrotasks();
    expect(ws.sent).toStrictEqual([]);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("does not revive Talk status after stop while a tool consult settles", async () => {
    const onStatus = vi.fn();
    const runId = "run-1";
    const { listeners, addEventListener } = createListeners();
    const client = {
      addEventListener,
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === "chat.abort") {
          expect(params).toEqual(abortTarget(runId));
          return { ok: true, aborted: true };
        }
        expect(method).toBe("talk.client.toolCall");
        expect(params.callId).toBe("call-1");
        expect(params.name).toBe(REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME);
        return {
          runId,
          idempotencyKey: runId,
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }),
    } as unknown as RealtimeTalkTransportContext["client"];
    const { transport, ws } = await startFixture({ onStatus }, client);
    onStatus.mockClear();

    ws.emitCalls(consultCall("call-1", { question: "check the session" }));
    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("thinking", undefined));
    await waitForFast(() => expect(listeners.size).toBe(1));

    transport.stop();
    for (const listener of listeners) {
      listener({ event: "chat", payload: { runId, state: "final", message: { text: "done" } } });
    }

    await waitForFast(() => {
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", abortTarget(runId));
    });
    expect(onStatus).not.toHaveBeenCalledWith("listening");
  });

  it.each([
    { model: undefined, scheduling: {} },
    { model: "gemini-3.8-live-extended-thinking", scheduling: {} },
    { model: "gemini-3.8-live", scheduling: { scheduling: "WHEN_IDLE" } },
  ])("submits consults with the expected scheduling for $model", async ({ model, scheduling }) => {
    const { listeners, addEventListener } = createListeners();
    const client = {
      addEventListener,
      request: vi.fn(async (method: string) => {
        expect(method).toBe("talk.client.toolCall");
        return consultRunResult();
      }),
    } as unknown as RealtimeTalkTransportContext["client"];
    const transport = await sessionTransport(
      {
        ...createSession(
          "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
        ),
        model,
      },
      client,
    );
    const ws = await startTransport(transport);
    ws.emitCalls(consultCall("call-1", { question: "check the session" }));
    await waitForFast(() => expect(listeners.size).toBe(1));
    for (const listener of listeners) {
      listener({
        event: "chat",
        payload: { runId: "run-1", state: "final", message: { text: "done" } },
      });
    }
    await waitForFast(() =>
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        toolResponse: {
          functionResponses: [
            {
              id: "call-1",
              name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
              ...scheduling,
              response: { result: "done" },
            },
          ],
        },
      }),
    );
    transport.stop();
  });

  it("does not retain browser tool arguments while a consult is pending", async () => {
    const client = createClient();
    vi.mocked(client["request"]).mockResolvedValue({ runId: "run-1" });
    const { transport, ws } = await startFixture({}, client);

    ws.emitCalls(consultCall("call-1", { prompt: "x".repeat(64 * 1024) }));

    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.get("call-1")).toStrictEqual({
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        cancelled: false,
        controller: expect.any(AbortController),
      }),
    );
    transport.stop();
  });

  it("answers unsupported browser tools once without retaining them", async () => {
    const transport = await createTransport();
    const ws = await startTransport(transport);

    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [{ id: "call-unknown", name: "unknown_tool", args: { value: 1 } }],
        },
      }),
    );

    await waitForFast(() =>
      expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        toolResponse: {
          functionResponses: [
            {
              id: "call-unknown",
              name: "unknown_tool",
              response: { error: 'Tool "unknown_tool" is not available in browser Talk' },
            },
          ],
        },
      }),
    );
    expect(getGoogleLiveToolOwnerState(transport).pendingCalls.size).toBe(0);
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: [{ id: "call-unknown", name: "unknown_tool", args: { value: 2 } }],
        },
      }),
    );
    await flushMicrotasks();
    expect(
      ws.sent
        .map((payload) => JSON.parse(payload))
        .filter((payload) => payload.toolResponse?.functionResponses?.[0]?.id === "call-unknown"),
    ).toHaveLength(1);
    transport.stop();
  });

  it("fails closed when an unsupported browser tool response cannot be sent", async () => {
    const onStatus = vi.fn();
    const { transport, ws } = await startFixture({ onStatus });
    vi.spyOn(ws, "send").mockImplementationOnce(() => {
      throw new Error("Google Live socket rejected the unsupported tool result");
    });

    ws.emitCalls({ id: "call-unknown", name: "unknown_tool", args: { value: 1 } });

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Google Live socket rejected the unsupported tool result",
      ),
    );
    expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-unknown")).toBe(false);
    expect(ws.readyState).toBe(3);
  });

  it("aborts only the browser consult cancelled by Google", async () => {
    const { listeners, addEventListener } = createListeners();
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "chat.abort") {
        return { ok: true, aborted: true };
      }
      expect(method).toBe("talk.client.toolCall");
      return {
        runId: `run-${String(params.callId)}`,
        idempotencyKey: `run-${String(params.callId)}`,
        agentId: "main",
        agentSessionKey: "agent:main:main",
      };
    });
    const client = {
      addEventListener,
      request,
    } as unknown as RealtimeTalkTransportContext["client"];
    const onStatus = vi.fn();
    const { transport, ws } = await startFixture({ onStatus }, client);

    ws.emitCalls(
      consultCall("call-1", { question: "first" }),
      consultCall("call-2", { question: "second" }),
    );
    await waitForFast(() => expect(listeners.size).toBe(2));
    onStatus.mockClear();

    cancelCall(ws, "call-1");

    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", abortTarget("run-call-1")),
    );
    expect(client["request"]).not.toHaveBeenCalledWith("chat.abort", abortTarget("run-call-2"));
    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-1")).toBe(false),
    );
    expect(onStatus).not.toHaveBeenCalledWith("listening");
    expect(hasToolResponse(ws, "call-1")).toBe(false);
    expect(onStatus).not.toHaveBeenCalledWith("error", expect.anything());

    cancelCall(ws, "call-2");
    await waitForFast(() =>
      expect(client["request"]).toHaveBeenCalledWith("chat.abort", abortTarget("run-call-2")),
    );
    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("listening"));
    transport.stop();
  });

  it("aborts an initial consult request and ignores a replay of its cancelled call id", async () => {
    const pendingToolCall = createDeferred<{
      runId: string;
      agentId: string;
      agentSessionKey: string;
    }>();
    const request = vi.fn((method: string): Promise<unknown> => {
      if (method === "talk.client.toolCall") {
        return pendingToolCall.promise;
      }
      expect(method).toBe("chat.abort");
      return Promise.resolve({ ok: true, aborted: true });
    });
    const client = {
      addEventListener: vi.fn(() => () => undefined),
      request,
    } as unknown as RealtimeTalkTransportContext["client"];
    const { transport, ws } = await startFixture({}, client);
    const toolCall = consultCall("call-1", { question: "check the session" });

    ws.emitCalls(toolCall);
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    cancelCall(ws, "call-1");
    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.get("call-1")?.cancelled).toBe(
        true,
      ),
    );
    pendingToolCall.resolve({
      runId: "run-1",
      agentId: "main",
      agentSessionKey: "agent:main:main",
    });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("chat.abort", abortTarget("run-1")),
    );
    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-1")).toBe(false),
    );

    ws.emitCalls(toolCall);
    await flushMicrotasks();
    expect(request.mock.calls.filter(([method]) => method === "talk.client.toolCall")).toHaveLength(
      1,
    );
    expect(hasToolResponse(ws, "call-1")).toBe(false);
    transport.stop();
  });

  it("aborts browser control requests without submitting their result", async () => {
    const pendingControl = createDeferred<{ ok: boolean; mode: string }>();
    const request = vi.fn((method: string): Promise<unknown> => {
      expect(method).toBe("talk.client.steer");
      return pendingControl.promise;
    });
    const client = {
      addEventListener: vi.fn(() => () => undefined),
      request,
    } as unknown as RealtimeTalkTransportContext["client"];
    const { transport, ws } = await startFixture({}, client);

    ws.emitCalls({
      id: "call-control",
      name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
      args: { text: "status", mode: "status" },
    });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    cancelCall(ws, "call-control");
    await waitForFast(() =>
      expect(
        getGoogleLiveToolOwnerState(transport).pendingCalls.get("call-control")?.cancelled,
      ).toBe(true),
    );
    pendingControl.resolve({ ok: true, mode: "status" });
    await waitForFast(() =>
      expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has("call-control")).toBe(false),
    );

    expect(hasToolResponse(ws, "call-control")).toBe(false);
    transport.stop();
  });

  it("fails closed before evicting seen browser tool-call ids", async () => {
    const onStatus = vi.fn();
    const { ws } = await startFixture({ onStatus });
    ws.emitMessage(
      encodeJsonFrame({
        toolCall: {
          functionCalls: Array.from({ length: 1_024 }, (_, index) => ({
            id: `call-${index}`,
            name: "unknown_tool",
          })),
        },
      }),
    );
    await flushMicrotasks();
    expect(ws.sent).toHaveLength(1_025);
    expect(ws.readyState).toBe(1);
    ws.emitCalls({ id: "overflow", name: "unknown_tool", args: {} });

    await flushMicrotasks();
    expect(onStatus).toHaveBeenCalledWith("error", "Google Live tool-call session limit exceeded");
    expect(ws.readyState).toBe(3);
    expect(ws.sent).toHaveLength(1_025);
  });
});
