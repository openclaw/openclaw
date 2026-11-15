import { once } from "node:events";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceResponseOutcome,
} from "openclaw/plugin-sdk/realtime-voice";
import { expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { createCatalogContextFixture } from "../../../plugins/capability-catalog.test-support.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import { acquireTestPortBlock } from "../../../test-utils/port-claims.js";
import { TalkRealtimeRelayOutputOwnership } from "./state.js";

it("hands an interrupted xAI response to its successor without losing Talk ownership", async () => {
  const { default: plugin } = await loadBundledPluginFacade<{
    default: { register: (api: OpenClawPluginApi) => void };
  }>({ pluginId: "xai", artifactBasename: "index.js" });
  const registerRealtimeVoiceProvider = vi.fn<OpenClawPluginApi["registerRealtimeVoiceProvider"]>();
  plugin.register(createTestPluginApi({ registerRealtimeVoiceProvider }));
  const factory = registerRealtimeVoiceProvider.mock.calls[0]?.[0];
  if (typeof factory !== "function") {
    throw new Error("Expected xAI voice provider factory");
  }
  const provider = factory(
    createCatalogContextFixture(() => {
      throw new Error("Unexpected host operation");
    }),
  );
  const harness = createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: "xai-interruption",
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
  const errors: string[] = [];
  const finished = Promise.withResolvers<void>();
  let failed = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const fail = (message: string) => {
    errors.push(message);
    failed.resolve();
    finished.resolve();
  };
  const ownership = new TalkRealtimeRelayOutputOwnership(
    () => harness.talk.activeTurnId,
    () => harness.ensureTurn(),
    fail,
    () => false,
  );
  const onTranscript = vi.fn();
  const onToolCall = vi.fn();
  const sendAudio = vi.fn();
  const outcomes = vi.fn((outcome: RealtimeVoiceResponseOutcome) =>
    ownership.finish(outcome.responseId),
  );
  const claim = await acquireTestPortBlock({ offsets: [0] });
  const server = new WebSocketServer({ host: "127.0.0.1", port: claim.port });
  const connected = new Promise<WebSocket>((resolve) => {
    server.once("connection", resolve);
  });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.once("message", () => socket.send(JSON.stringify({ type: "session.updated" })));
  });
  const session = harness.createBridge({
    provider: ownership.bind(provider, vi.fn()),
    providerConfig: { apiKey: "fixture-value", baseUrl: `http://127.0.0.1:${claim.port}/v1` },
    audioSink: { sendAudio },
    onTranscript,
    onToolCall,
    onResponseDone: outcomes,
    onError: (error) => fail(error.message),
    onClose: () => closed.resolve(),
    onEvent: (event) => {
      if (
        event.direction === "server" &&
        event.type === "response.done" &&
        event.responseId === "B"
      ) {
        finished.resolve();
      }
    },
  });
  try {
    await session.bridge.connect();
    const socket = await connected;
    const send = (type: string, fields: object = {}) =>
      socket.send(JSON.stringify({ type, ...fields }));
    send("response.created", { response: { id: "A" } });
    send("response.function_call_arguments.done", {
      response_id: "A",
      item_id: "old-tool",
      call_id: "old-call",
      name: "lookup",
      arguments: "{}",
    });
    send("input_audio_buffer.speech_started");
    send("conversation.item.input_audio_transcription.completed", {
      item_id: "question",
      transcript: "new question",
    });
    // The provider may replace A without ever delivering its terminal.
    send("response.created", { response: { id: "B" } });
    send("response.output_audio.delta", { response_id: "A", delta: "AAA=" });
    send("response.output_text.done", { response_id: "A", text: "stale answer" });
    send("response.done", { response: { id: "A", status: "cancelled" } });
    send("response.output_audio.delta", { response_id: "B", delta: "AAA=" });
    send("response.done", { response: { id: "B", status: "completed" } });
    await finished.promise;
    expect(errors).toEqual([]);
    expect(session.bridge.isConnected()).toBe(true);
    expect(outcomes.mock.calls.map(([outcome]) => outcome)).toEqual([
      { status: "cancelled", responseId: "A" },
      { status: "completed", responseId: "B" },
    ]);
    const terminals = harness.talk.recentEvents.filter(
      (event) => event.type === "turn.cancelled" || event.type === "turn.ended",
    );
    expect(terminals.map((event) => event.type)).toEqual(["turn.cancelled", "turn.ended"]);
    expect(terminals[0]?.turnId).not.toBe(terminals[1]?.turnId);
    expect(ownership.phase).toBe("unowned");
    expect(sendAudio).toHaveBeenCalledOnce();
    expect(onToolCall).not.toHaveBeenCalled();
    expect(onTranscript.mock.calls.filter((call) => call[2])).toEqual([
      ["user", "new question", true, { textMode: "snapshot" }],
    ]);
    // Cancellation recovery must not hide a genuine provider failure.
    send("error", { error: { message: "Provider authentication failed" } });
    await failed.promise;
    expect(errors).toEqual(["Provider authentication failed"]);
    failed = Promise.withResolvers<void>();
    send("response.created", { response: { id: "C" } });
    send("response.created", { response: { id: "D" } });
    await failed.promise;
    expect(errors).toContain("Realtime provider output has no live response owner.");
    send("response.output_audio.delta", { response_id: "D", delta: "not base64" });
    await closed.promise;
    expect(session.bridge.isConnected()).toBe(false);
    expect(errors).toContain("xAI realtime voice stream returned malformed base64 audio data");
  } finally {
    await session.close();
    harness.close();
    for (const socket of server.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await claim.release();
  }
});
