import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import {
  audioContexts,
  audioTurn,
  expectAudioReleased,
  toolResponse,
  startFixture,
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
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "./shared.ts";

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

function abortTarget(runId: string) {
  return { sessionKey: "agent:main:main", agentId: "main", runId };
}
function hasToolResponse(ws: ReturnType<typeof latestWebSocket>, id: string) {
  return ws.sent
    .map((payload) => JSON.parse(payload))
    .some((payload) => payload.toolResponse?.functionResponses?.[0]?.id === id);
}

function cancelCall(ws: ReturnType<typeof latestWebSocket>, id: string) {
  ws.emitMessage(encodeJsonFrame({ toolCallCancellation: { ids: [id] } }));
}

async function startActiveControlFixture(controlResult: Record<string, unknown>) {
  const client = createClient();
  vi.mocked(client["request"]).mockImplementation(async (method) => {
    if (method === "talk.client.toolCall") {
      return { runId: "run-1" };
    }
    if (method === "talk.client.steer") {
      return {
        ok: true,
        sessionKey: "main",
        active: true,
        speak: true,
        show: true,
        suppress: false,
        ...controlResult,
      };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const transport = await createTransport({}, client);
  const ws = await startTransport(transport);
  ws.emitContent(audioTurn());
  await waitForFast(() => expect(createdSources).toHaveLength(1));
  ws.emitCalls({
    id: "call-1",
    name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    args: { question: "status?" },
  });
  await waitForFast(() =>
    expect(client["request"]).toHaveBeenCalledWith("talk.client.toolCall", expect.any(Object)),
  );
  return { client, transport, ws };
}

async function sendControl(
  { client, ws }: Pick<Awaited<ReturnType<typeof startActiveControlFixture>>, "client" | "ws">,
  text: string,
) {
  ws.emitContent({ inputTranscription: { text, finished: true } });
  await waitForFast(() =>
    expect(client["request"]).toHaveBeenCalledWith("talk.client.steer", expect.any(Object)),
  );
  expect(createdSources[0]?.stop).toHaveBeenCalledTimes(1);
}

async function startModel(model?: string) {
  const onTranscript = vi.fn();
  const onStatus = vi.fn();
  const transport = await createTransport({ onTranscript, onStatus }, createClient(), undefined, {
    model,
  });
  return { transport, ws: await startTransport(transport), onTranscript, onStatus };
}

describe("GoogleLiveRealtimeTalkTransport", () => {
  installGoogleLiveTestFixture();

  it("connects only to the allowlisted endpoint with the ephemeral token", async () => {
    const transport = await createTransport(
      {},
      createClient(),
      undefined,
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
    const transport = await createTransport(
      {},
      createClient(),
      undefined,
      createSession(websocketUrl),
    );

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
    expectAudioReleased();
    expect(inputProcessors.at(-1)?.disconnect).toHaveBeenCalledOnce();
    expect(audioContexts).toHaveLength(2);
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

      expectAudioReleased();
      expect(inputProcessors.at(-1)?.disconnect).toHaveBeenCalledOnce();
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
    expectAudioReleased();
    expect(inputProcessors).toHaveLength(0);
    expect(ws.readyState).toBe(3);
  });

  it("stops queued output when Google Live sends interruption", async () => {
    const { ws } = await startFixture();

    ws.emitContent(audioTurn("AAAAAA=="));
    await waitForFast(() => expect(createdSources).toHaveLength(1));

    const source = createdSources[0];
    ws.emitContent({ interrupted: true });

    await waitForFast(() => expect(source?.stop).toHaveBeenCalledTimes(1));
  });

  it("closes an overflowing playback response and ignores late provider audio", async () => {
    const onStatus = vi.fn();
    const { ws } = await startFixture({ onStatus });

    ws.emitContent(audioTurn("AAAA", 4_097));

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "Realtime Talk playback exceeded the browser audio buffer limit",
      ),
    );
    expect(createdSources).toHaveLength(4_096);
    expect(createdSources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
    expect(ws.readyState).toBe(3);

    ws.emitContent(audioTurn("AAAA"));
    await flushMicrotasks();
    expect(createdSources).toHaveLength(4_096);
  });

  it("rejects an oversized first frame before decoding provider audio", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const ws = await startTransport(transport);

    ws.emitContent(audioTurn("!".repeat(3_904_000)));

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

  it("ignores late WebSocket events after stop", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn();
    const transport = await createTransport({ onStatus, onTalkEvent });
    const { start, ws } = await beginTransport(transport);
    onStatus.mockClear();

    transport.stop();
    await expect(start).resolves.toBe("cancelled");
    ws.emitOpen();
    ws.emitMessage(encodeJsonFrame({ setupComplete: {} }));

    await flushMicrotasks();
    expect(ws.sent).toStrictEqual([]);
    expect(ws.readyState).toBe(3);
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("does not revive Talk status after stop while a tool consult settles", async () => {
    const onStatus = vi.fn();
    const runId = "run-1";
    const { listeners, addEventListener } = createListeners();
    const client = createClient(
      vi.fn(async (method: string, params: Record<string, unknown>) => {
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
      addEventListener,
    );
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
    const client = createClient(
      vi.fn(async (method: string) => {
        expect(method).toBe("talk.client.toolCall");
        return {
          runId: "run-1",
          idempotencyKey: "run-1",
          agentId: "main",
          agentSessionKey: "agent:main:main",
        };
      }),
      addEventListener,
    );
    const transport = await createTransport({}, client, undefined, { model });
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
      expect(ws.messages).toContainEqual(
        toolResponse(
          "call-1",
          REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
          { result: "done" },
          scheduling,
        ),
      ),
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

  it.each([
    { name: "unknown_tool", id: "call-unknown", args: { value: 1 }, control: false },
    {
      name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
      id: "call-control",
      args: { text: "status", mode: "status" },
      control: true,
    },
  ])("fails closed when $name cannot submit a tool result", async ({ name, id, args, control }) => {
    const onStatus = vi.fn();
    const client = createClient();
    if (control) {
      vi.mocked(client["request"]).mockImplementation(async (method) => {
        if (method !== "talk.client.steer") {
          throw new Error(`unexpected request: ${method}`);
        }
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "Still working.",
        };
      });
    }
    const { transport, ws } = await startFixture({ onStatus }, client);
    const detail = "Google Live socket rejected the tool result";
    const reject = () => {
      throw new Error(detail);
    };
    if (control) {
      vi.spyOn(ws, "send").mockImplementation(reject);
    } else {
      vi.spyOn(ws, "send").mockImplementationOnce(reject);
    }
    ws.emitCalls({ id, name, args });
    await waitForFast(() => expect(onStatus).toHaveBeenCalledWith("error", detail));
    expect(getGoogleLiveToolOwnerState(transport).pendingCalls.has(id)).toBe(false);
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
    const client = createClient(request, addEventListener);
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
    const client = createClient(request);
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
    const client = createClient(request);
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

  it.each([
    { mode: "status", text: "status", message: "OpenClaw is working in read (running)." },
    {
      mode: "steer",
      text: "actually focus on WebUI",
      message: "Got it. I steered the active run.",
    },
  ])(
    "speaks $mode acknowledgements after interrupting queued audio",
    async ({ mode, text, message }) => {
      const { client, transport, ws } = await startActiveControlFixture({
        mode,
        message,
        ...(mode === "steer" ? { queued: true } : {}),
      });
      await sendControl({ client, ws }, text);
      expect(ws.messages).toContainEqual({
        realtimeInput: { text: expect.stringContaining(`Status: "${message}"`) },
      });
      transport.stop();
    },
  );

  it("interrupts queued output when active-control cancel is suppressed in Google Live", async () => {
    const { client, transport, ws } = await startActiveControlFixture({
      mode: "cancel",
      aborted: true,
      message: "Cancelled the active OpenClaw run.",
    });

    await sendControl({ client, ws }, "cancel that");
    const sent = ws.sent.map((payload) => JSON.parse(payload));
    expect(sent.some((event) => event.clientContent)).toBe(false);
    transport.stop();
  });
  it.each([
    { name: "default 3.1", model: undefined },
    { name: "3.8", model: "gemini-3.8-live" },
    { name: "3.8 Extended Thinking", model: "gemini-3.8-live-extended-thinking" },
    { name: "prefixed 3.8", model: "models/gemini-3.8-live" },
  ])("finalizes both live $name spoken turns before the session closes", async ({ model }) => {
    const { transport, ws, onTranscript } = await startModel(model);
    for (const [input, output] of [
      ["Please reply with the single word glacier.", "Glacier."],
      ["Now reply with the single word crystal.", "Crystal."],
    ]) {
      for (const serverContent of [
        { inputTranscription: { text: input } },
        { outputTranscription: { text: output } },
        { generationComplete: true },
        { turnComplete: true },
      ]) {
        ws.emitContent(serverContent);
        await flushMicrotasks();
      }
    }
    expect(onTranscript.mock.calls.map(([entry]) => entry).filter((entry) => entry.final)).toEqual([
      { role: "user", text: "Please reply with the single word glacier.", final: true },
      { role: "assistant", text: "Glacier.", final: true },
      { role: "user", text: "Now reply with the single word crystal.", final: true },
      { role: "assistant", text: "Crystal.", final: true },
    ]);
    expect(
      onTranscript.mock.calls
        .filter(([entry]) => entry.role === "user")
        .map(([entry]) => entry.final),
    ).toEqual([true, true]);
    ws.emitContent({ inputTranscription: { finished: true } });
    await flushMicrotasks();
    transport.stop();
    expect(onTranscript.mock.calls.filter(([entry]) => entry.final)).toHaveLength(4);
  });

  it("accumulates 2.5 fragments and honors a finish-only message", async () => {
    const { transport, ws, onTranscript } = await startModel(
      "gemini-2.5-flash-native-audio-preview-12-2025",
    );
    for (const transcription of [{ text: "Last " }, { text: "words" }, { finished: true }]) {
      ws.emitContent({ inputTranscription: transcription });
      await flushMicrotasks();
    }
    expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
      { role: "user", text: "Last ", final: false },
      { role: "user", text: "words", final: false },
      { role: "user", text: "Last words", final: true },
    ]);
    transport.stop();
  });

  const interrupted = { interrupted: true };
  const complete = { turnComplete: true };
  const nextInput = { inputTranscription: { text: "New question" } };
  it.each([
    ["before next input", [interrupted, complete, nextInput]],
    ["after next input", [interrupted, nextInput, complete]],
    ["in interruption frame", [{ ...interrupted, ...complete }, nextInput]],
  ] as const)(
    "preserves interrupted speech and the next utterance when completion arrives %s",
    async (_name, boundary) => {
      const { transport, ws, onTranscript } = await startModel();
      for (const serverContent of [
        { outputTranscription: { text: "Interrupted " } },
        { outputTranscription: { text: "response" } },
        ...boundary,
        { outputTranscription: { text: "Next response", finished: true } },
        { turnComplete: true },
      ]) {
        ws.emitContent(serverContent);
        await flushMicrotasks();
      }
      expect(
        onTranscript.mock.calls.filter(([entry]) => entry.final).map(([entry]) => entry.text),
      ).toEqual(["Interrupted response", "New question", "Next response"]);
      transport.stop();
      expect(onTranscript.mock.calls.filter(([entry]) => entry.final)).toHaveLength(3);
    },
  );

  it("releases the UTF-8 transcript budget on finality and closes on overflow without persisting a partial", async () => {
    const { ws, onTranscript, onStatus } = await startModel();
    const atLimit = "é".repeat(128 * 1024);
    for (const outputTranscription of [
      { text: atLimit },
      { finished: true },
      { text: atLimit },
      { text: "é" },
      { finished: true },
    ]) {
      ws.emitContent({ outputTranscription });
      await flushMicrotasks();
    }
    expect(
      onTranscript.mock.calls.filter(([entry]) => entry.final).map(([entry]) => entry.text),
    ).toEqual([atLimit]);
    expect(onTranscript).toHaveBeenCalledTimes(3);
    expect(onStatus).toHaveBeenCalledWith(
      "error",
      "Google Live transcript exceeded the 256 KiB UTF-8 pending buffer limit",
    );
    expect(ws.readyState).toBe(3);
  });

  it("stays active across a filler utterance and tool call", async () => {
    const { transport, ws, onTranscript } = await startModel("gemini-3.8-live-extended-thinking");

    ws.emitContent({
      outputTranscription: { text: "Checking now." },
      turnComplete: true,
      interactionStatus: "IN_PROGRESS",
    });
    await waitForFast(() =>
      expect(onTranscript).toHaveBeenLastCalledWith({
        role: "assistant",
        text: "Checking now.",
        final: true,
      }),
    );

    ws.emitCalls({ id: "call-unknown", name: "unknown_tool", args: {} });
    await waitForFast(() =>
      expect(ws.messages).toContainEqual(
        toolResponse("call-unknown", "unknown_tool", {
          error: 'Tool "unknown_tool" is not available in browser Talk',
        }),
      ),
    );
    expect(ws.readyState).toBe(1);
    expect(getGoogleLiveToolOwnerState(transport).pendingCalls.size).toBe(0);
    ws.emitCalls({ id: "call-unknown", name: "unknown_tool", args: { value: 2 } });
    await flushMicrotasks();
    expect(
      ws.sent
        .map((payload) => JSON.parse(payload))
        .filter((payload) => payload.toolResponse?.functionResponses?.[0]?.id === "call-unknown"),
    ).toHaveLength(1);

    ws.emitContent({
      outputTranscription: { text: "The answer is 42." },
      turnComplete: true,
      interactionStatus: "IDLE",
    });
    await waitForFast(() =>
      expect(onTranscript).toHaveBeenLastCalledWith({
        role: "assistant",
        text: "The answer is 42.",
        final: true,
      }),
    );
    expect(ws.readyState).toBe(1);
    transport.stop();
  });
});
