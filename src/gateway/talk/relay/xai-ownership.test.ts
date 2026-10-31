import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createRealtimeVoiceSessionHarness } from "openclaw/plugin-sdk/realtime-voice";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice-provider";
import { beforeEach, expect, it, vi } from "vitest";
import { createCatalogContextFixture } from "../../../plugins/capability-catalog.test-support.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { TalkRealtimeRelayOutputOwnership } from "./state.js";

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  class TestWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static constructed = Promise.withResolvers<TestWebSocket>();
    readyState = TestWebSocket.CONNECTING;
    constructor(..._args: unknown[]) {
      super();
      TestWebSocket.constructed.resolve(this);
    }
    send(_payload: string) {}
    close() {
      this.readyState = 3;
      this.emit("close", 1000, Buffer.from(""));
    }
    terminate() {
      this.close();
    }
    emitServer(event: unknown) {
      this.emit("message", Buffer.from(JSON.stringify(event)));
    }
    open() {
      this.readyState = TestWebSocket.OPEN;
      this.emit("open");
    }
  }
  return { FakeWebSocket: TestWebSocket };
});
vi.mock("../../../../extensions/xai/ws-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  WebSocket: FakeWebSocket,
}));
beforeEach(() => {
  FakeWebSocket.constructed = Promise.withResolvers<InstanceType<typeof FakeWebSocket>>();
});

async function registeredProvider(): Promise<RealtimeVoiceProviderPlugin> {
  const { default: xaiPlugin } = await loadBundledPluginFacade<{
    default: { register: (api: OpenClawPluginApi) => void };
  }>({ pluginId: "xai", artifactBasename: "index.js" });
  const registerRealtimeVoiceProvider = vi.fn<OpenClawPluginApi["registerRealtimeVoiceProvider"]>();
  xaiPlugin.register(createTestPluginApi({ registerRealtimeVoiceProvider }));
  const factory = registerRealtimeVoiceProvider.mock.calls[0]?.[0];
  expect(factory).toBeTypeOf("function");
  if (typeof factory !== "function") {
    throw new Error("expected xAI realtime provider factory");
  }
  return factory(
    createCatalogContextFixture(() => {
      throw new Error("registration must not invoke host operations");
    }),
  );
}
function server(socket: InstanceType<typeof FakeWebSocket>, type: string, data: object = {}) {
  socket.emitServer({ type, ...data });
}
function responseCreated(socket: InstanceType<typeof FakeWebSocket>, id: string) {
  server(socket, "response.created", { response: { id } });
}
function responseDone(socket: InstanceType<typeof FakeWebSocket>, id: string) {
  server(socket, "response.done", { response: { id, status: "completed" } });
}
function inputTranscript(socket: InstanceType<typeof FakeWebSocket>, text: string, itemId: string) {
  server(socket, "conversation.item.input_audio_transcription.completed", {
    item_id: itemId,
    transcript: text,
  });
}
it("settles a server-VAD predecessor before admitting its successor through Talk", async () => {
  const harness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: "vad-test",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "xai",
    },
    talkPayloads: {
      turnStarted: () => ({}),
      turnEnded: (reason) => ({ reason }),
      inputAudioDelta: () => ({}),
      outputAudioStarted: () => ({}),
      outputAudioDelta: () => ({}),
      outputAudioDone: (reason) => ({ reason }),
    },
  });
  const fail = vi.fn();
  const ownership = new TalkRealtimeRelayOutputOwnership(
    () => harness.talk.activeTurnId,
    () => harness.ensureTurn(),
    fail,
    () => false,
  );
  const onTranscript = vi.fn();
  const onToolCall = vi.fn();
  const sendAudio = vi.fn();
  const outcomes = vi.fn((outcome) => ownership.finish(outcome.responseId));
  const session = harness.createBridge({
    provider: ownership.bind(await registeredProvider(), vi.fn()),
    providerConfig: { apiKey: "xai-test" },
    audioSink: { sendAudio },
    onTranscript,
    onToolCall,
    onResponseDone: outcomes,
  });
  try {
    const connecting = session.bridge.connect();
    const socket = await FakeWebSocket.constructed.promise;
    socket.open();
    server(socket, "session.updated");
    await connecting;
    responseCreated(socket, "A");
    const firstTurn = harness.talk.activeTurnId;
    server(socket, "input_audio_buffer.speech_started");
    inputTranscript(socket, "new question", "user-B");
    responseCreated(socket, "B");
    expect(fail).not.toHaveBeenCalled();
    expect(outcomes).toHaveBeenCalledExactlyOnceWith({ status: "cancelled", responseId: "A" });
    expect(ownership.responseId).toBe("B");
    expect(harness.talk.activeTurnId).not.toBe(firstTurn);
    expect(
      harness.talk.recentEvents.some(
        (event) => event.type === "turn.cancelled" && event.turnId === firstTurn,
      ),
    ).toBe(true);
    server(socket, "response.output_audio.delta", { response_id: "A", delta: "AAA=" });
    server(socket, "response.output_text.done", { response_id: "A", text: "stale" });
    server(socket, "response.function_call_arguments.done", {
      response_id: "A",
      item_id: "old",
      call_id: "old",
      name: "lookup",
      arguments: "{}",
    });
    responseDone(socket, "A");
    expect(sendAudio).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onTranscript.mock.calls.some((call) => call[1] === "stale")).toBe(false);
    expect(ownership.responseId).toBe("B");
    server(socket, "response.output_audio.delta", { response_id: "B", delta: "AAA=" });
    responseDone(socket, "B");
    expect(sendAudio).toHaveBeenCalledOnce();
    expect(ownership.phase).toBe("unowned");
    expect(onTranscript.mock.calls).toContainEqual([
      "user",
      "new question",
      true,
      { textMode: "snapshot" },
    ]);
    responseCreated(socket, "C");
    responseCreated(socket, "C");
    expect(fail).not.toHaveBeenCalled();
    responseCreated(socket, "arbitrary-overlap");
    expect(fail).toHaveBeenCalledExactlyOnceWith(
      "Realtime provider output has no live response owner.",
    );
  } finally {
    await session.close();
    harness.close();
  }
});
