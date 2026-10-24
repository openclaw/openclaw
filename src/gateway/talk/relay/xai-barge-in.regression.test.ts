import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { FakeWebSocket } = await vi.hoisted(
  () => import("../../../../extensions/xai/realtime-voice-socket.test-support.js"),
);

vi.mock("../../../../extensions/xai/ws-runtime.js", () => ({
  WebSocket: FakeWebSocket,
}));

import { buildXaiRealtimeVoiceProvider } from "../../../../extensions/xai/realtime-voice-provider.js";
import { resolveRealtimeVoiceProviderCapabilitiesAsync } from "../../../talk/provider-resolver.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { prepareTalkSessionTarget } from "../session-target.js";
import { closeRelaySession } from "./operations.js";
import { createTalkRealtimeRelaySession } from "./session-create.js";
import { relaySessions } from "./state.js";

const cfg = { agents: { entries: { main: {} } } };
const providerConfig = { apiKey: "xai-test" }; // pragma: allowlist secret

type RelayEvent = { type: string; message?: string; reason?: string };

function pcmDelta(responseId: string, itemId: string) {
  return {
    type: "response.output_audio.delta",
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: Buffer.alloc(4800).toString("base64"),
  };
}

describe("Talk relay with xAI server-VAD barge-in", () => {
  let state: OpenClawTestState;
  let relaySessionId: string | undefined;

  beforeEach(async () => {
    FakeWebSocket.instances = [];
    state = await createOpenClawTestState({ label: "relay-xai-barge-in", applyEnv: true });
  });

  afterEach(async () => {
    const session = relaySessionId ? relaySessions.get(relaySessionId) : undefined;
    if (session) {
      await closeRelaySession(session, "completed");
    }
    relaySessionId = undefined;
    await state.cleanup();
  });

  async function openRelay() {
    const events: RelayEvent[] = [];
    const provider = buildXaiRealtimeVoiceProvider();
    const capabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
      provider,
      providerConfig,
      cfg,
      surface: "gateway-relay",
    });
    const session = createTalkRealtimeRelaySession({
      context: {
        broadcastToConnIds: vi.fn((_event: string, payload: RelayEvent) => {
          events.push(payload);
        }),
        chatAbortControllers: new Map(),
      } as never,
      connId: "conn-1",
      cfg,
      provider,
      providerConfig,
      controlSource: capabilities?.handlesAgentConsult === true ? "delegation" : "transcript",
      capabilities,
      instructions: "be brief",
      tools: [],
      sessionTarget: await prepareTalkSessionTarget(cfg, "agent:main:main"),
      forceAgentConsultOnFinalTranscript: false,
    });
    relaySessionId = session.relaySessionId;
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(1), { interval: 1 });
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    socket.emitServer({ type: "session.updated" });
    await vi.waitFor(() => expect(events.some((e) => e.type === "ready")).toBe(true), {
      interval: 1,
    });
    return { socket, events };
  }

  // Observed live: xAI server VAD replaces an unspoken reply with a successor
  // response.created and never sends a terminal for the replaced reply.
  it("keeps the session open when xAI replaces a reply without a terminal", async () => {
    const { socket, events } = await openRelay();

    socket.emitServer({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      content_index: 0,
      transcript: "Please say",
    });
    socket.emitServer({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    socket.emitServer({ type: "response.created", response: { id: "r1", status: "in_progress" } });
    socket.emitServer({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    socket.emitServer({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      content_index: 0,
      transcript: "Please say hello back to me",
    });
    socket.emitServer({ type: "response.created", response: { id: "r2", status: "in_progress" } });
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "r2",
      output_index: 0,
      item: { id: "a2", type: "message", role: "assistant" },
    });
    socket.emitServer(pcmDelta("r2", "a2"));
    socket.emitServer({ type: "response.done", response: { id: "r2", status: "completed" } });

    await vi.waitFor(() => expect(events.some((e) => e.type === "audio")).toBe(true), {
      interval: 1,
    });
    expect(events.filter((e) => e.type === "error" || e.type === "close")).toEqual([]);
  });

  it("keeps the session open when speech cancels a reply before its audio", async () => {
    const { socket, events } = await openRelay();

    socket.emitServer({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    socket.emitServer({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    socket.emitServer({ type: "response.created", response: { id: "r1", status: "in_progress" } });
    socket.emitServer({ type: "input_audio_buffer.committed", item_id: "u1" });
    socket.emitServer({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "u1",
      content_index: 0,
      transcript: "Please say",
    });
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "r1",
      output_index: 0,
      item: { id: "a1", type: "message", role: "assistant" },
    });
    // The user keeps talking: server VAD barges in and the bridge cancels r1.
    socket.emitServer({ type: "input_audio_buffer.speech_started", item_id: "u2" });
    socket.emitServer({ type: "response.done", response: { id: "r1", status: "cancelled" } });
    socket.emitServer({ type: "input_audio_buffer.speech_stopped", item_id: "u2" });
    socket.emitServer({ type: "response.created", response: { id: "r2", status: "in_progress" } });
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "r2",
      output_index: 0,
      item: { id: "a2", type: "message", role: "assistant" },
    });
    socket.emitServer(pcmDelta("r2", "a2"));
    socket.emitServer({ type: "response.done", response: { id: "r2", status: "completed" } });

    await vi.waitFor(() => expect(events.some((e) => e.type === "audio")).toBe(true), {
      interval: 1,
    });
    expect(events.filter((e) => e.type === "error" || e.type === "close")).toEqual([]);
  });

  it("keeps the session open when speech cancels a reply during its audio", async () => {
    const { socket, events } = await openRelay();

    socket.emitServer({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    socket.emitServer({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    socket.emitServer({ type: "response.created", response: { id: "r1", status: "in_progress" } });
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "r1",
      output_index: 0,
      item: { id: "a1", type: "message", role: "assistant" },
    });
    socket.emitServer(pcmDelta("r1", "a1"));
    socket.emitServer({ type: "input_audio_buffer.speech_started", item_id: "u2" });
    socket.emitServer(pcmDelta("r1", "a1"));
    socket.emitServer({ type: "response.done", response: { id: "r1", status: "cancelled" } });
    socket.emitServer({ type: "input_audio_buffer.speech_stopped", item_id: "u2" });
    socket.emitServer({ type: "response.created", response: { id: "r2", status: "in_progress" } });
    socket.emitServer({
      type: "response.output_item.added",
      response_id: "r2",
      output_index: 0,
      item: { id: "a2", type: "message", role: "assistant" },
    });
    socket.emitServer(pcmDelta("r2", "a2"));
    socket.emitServer({ type: "response.done", response: { id: "r2", status: "completed" } });

    await vi.waitFor(
      () => expect(events.filter((e) => e.type === "audio").length).toBeGreaterThan(1),
      { interval: 1 },
    );
    expect(events.filter((e) => e.type === "error" || e.type === "close")).toEqual([]);
  });
});
