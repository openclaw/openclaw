// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../../src/talk/describe-view-tool.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
} from "./shared.ts";
import {
  createWebRtcTransport,
  dispatchCompletedToolCall,
  dispatchRealtimeEvent,
  FakePeerConnection,
  sentRealtimeEvents,
  stubMicrophone,
  startWebRtcTransport,
} from "./webrtc.test-support.ts";
import type { WebRtcSdpRealtimeTalkTransport } from "./webrtc.ts";

let stopInputTrack: ReturnType<typeof vi.fn>;

function dispatchControlToolCall(
  peer: FakePeerConnection | undefined,
  args: { text: string; mode: "status" | "steer" },
): void {
  dispatchCompletedToolCall(peer, {
    name: REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
    arguments: JSON.stringify(args),
  });
}

describe("WebRtcSdpRealtimeTalkTransport control tool", () => {
  beforeEach(() => {
    FakePeerConnection.instances = [];
    ({ stopInputTrack } = stubMicrophone());
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("answer-sdp")) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submits control results without optional response and item ids", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "steer",
          sessionKey: "main",
          active: true,
          queued: true,
          message: "Got it. I steered the active run.",
          speak: true,
          show: true,
          suppress: false,
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const { transport } = await createWebRtcTransport({
      client: { addEventListener: vi.fn(() => () => undefined), request },
    });

    await transport.start();
    const peer = FakePeerConnection.instances[0];
    dispatchCompletedToolCall(peer, {
      responseId: null,
      itemId: null,
      arguments: JSON.stringify({ text: "revísalo en WebUI", mode: "steer" }),
    });

    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.steer", {
        sessionKey: "main",
        text: "revísalo en WebUI",
        mode: "steer",
      }),
    );
    const sent = sentRealtimeEvents(peer);
    expect(sent).toContainEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call-control",
        output: expect.stringContaining('"mode":"steer"'),
      },
    });
    transport.stop();
  });

  it.each(["resolved", "rejected"])(
    "discards a pending control %s after its transport stops and a replacement starts",
    async (outcome) => {
      const pending = createDeferred<unknown>();
      const request = vi.fn(() => pending.promise);
      const {
        transport,
        peer: previousPeer,
        onTalkEvent,
      } = await startWebRtcTransport({ request });
      dispatchControlToolCall(previousPeer, { text: "status", mode: "status" });
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());

      transport.stop();
      const { transport: replacement, peer: replacementPeer } = await startWebRtcTransport(
        { request },
        { onTalkEvent },
      );
      onTalkEvent.mockClear();
      if (outcome === "resolved") {
        pending.resolve({ ok: true, mode: "status", message: "Old call finished." });
      } else {
        pending.reject(new Error("Old control failed"));
      }
      await pending.promise.catch(() => undefined);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(onTalkEvent).not.toHaveBeenCalled();
      expect(sentRealtimeEvents(previousPeer)).toEqual([]);
      expect(sentRealtimeEvents(replacementPeer)).toEqual([]);
      expect(replacementPeer?.connectionState).not.toBe("closed");
      replacement.stop();
    },
  );

  it("executes completed calls once and ignores provisional events", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.toolCall") {
        return { runId: "run-1" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const { transport, peer } = await startWebRtcTransport({
      addEventListener: vi.fn(() => () => undefined),
      request,
    });

    for (const type of [
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
    ]) {
      dispatchRealtimeEvent(peer, {
        type,
        item_id: "item-1",
        call_id: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        arguments: JSON.stringify({ question: "provisional" }),
        delta: JSON.stringify({ question: "provisional" }),
      });
    }
    expect(request).not.toHaveBeenCalled();

    dispatchCompletedToolCall(peer, {
      itemId: "item-1",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      arguments: JSON.stringify({ question: "status?" }),
    });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("talk.client.toolCall", {
        sessionKey: "main",
        callId: "call-1",
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "status?" },
      }),
    );

    dispatchCompletedToolCall(peer, {
      responseId: "response-2",
      itemId: "item-2",
      callId: "call-1",
      name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
      arguments: JSON.stringify({ question: "late" }),
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(request).toHaveBeenCalledTimes(1);
    transport.stop();
  });

  it.each([
    { label: "cancelled response", responseStatus: "cancelled" },
    { label: "incomplete item", itemStatus: "incomplete" },
    { label: "missing call", callId: null },
    { label: "missing name", name: null },
    { label: "missing arguments", arguments: null },
  ])("ignores a function call with $label", async ({ label: _label, ...overrides }) => {
    const request = vi.fn();
    const { transport, peer } = await startWebRtcTransport({ request });
    dispatchCompletedToolCall(peer, overrides);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(request).not.toHaveBeenCalled();
    transport.stop();
  });

  it("enforces the authoritative 256000-byte UTF-8 argument limit", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return { ok: true, mode: "status" };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const { transport, peer } = await startWebRtcTransport({ request });
    const baseArgs = JSON.stringify({ text: "status" });
    const argumentsAtLimit = baseArgs + " ".repeat(256_000 - baseArgs.length);
    const oversizedArguments = JSON.stringify({ text: "é".repeat(128_000) });

    dispatchCompletedToolCall(peer, { arguments: argumentsAtLimit });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());
    dispatchCompletedToolCall(peer, {
      responseId: "response-2",
      itemId: "item-2",
      callId: "call-2",
      arguments: oversizedArguments,
    });
    dispatchCompletedToolCall(peer, {
      responseId: "response-3",
      itemId: "item-3",
      callId: "call-2",
      arguments: oversizedArguments,
    });

    expect(new TextEncoder().encode(argumentsAtLimit)).toHaveLength(256_000);
    expect(new TextEncoder().encode(oversizedArguments).byteLength).toBeGreaterThan(256_000);
    const outputs = sentRealtimeEvents(peer).filter(
      (event) =>
        event.type === "conversation.item.create" && event.item?.type === "function_call_output",
    );
    expect(outputs).toHaveLength(2);
    expect(JSON.parse(String(outputs[1]?.item?.output))).toEqual({
      error: "Realtime tool arguments exceed the 256000-byte UTF-8 limit",
    });
    transport.stop();
  });

  it("ends the session instead of evicting completed call identities", async () => {
    const { peer, onStatus } = await startWebRtcTransport();

    const dispatchView = (suffix: string | number) =>
      dispatchCompletedToolCall(peer, {
        responseId: `response-${suffix}`,
        itemId: `item-${suffix}`,
        callId: `call-${suffix}`,
        name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
        arguments: "{}",
      });
    for (let index = 0; index < 1_024; index += 1) {
      dispatchView(index);
    }
    dispatchView("overflow");

    expect(onStatus).toHaveBeenCalledWith("error", "Realtime tool-call session limit exceeded");
    expect(peer?.channel.close).toHaveBeenCalledOnce();
    dispatchView("late");
    expect(peer?.channel.close).toHaveBeenCalledOnce();
  });

  it("surfaces OpenAI tool-result send failures without an unhandled rejection", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "talk.client.steer") {
        return {
          ok: true,
          mode: "status",
          sessionKey: "main",
          active: true,
          message: "Still working.",
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const { transport, peer, onStatus } = await startWebRtcTransport({ request });

    peer?.channel.send.mockImplementation(() => {
      throw new Error("OpenAI data channel rejected the tool result");
    });
    dispatchControlToolCall(peer, { text: "status", mode: "status" });

    await waitForFast(() =>
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        "OpenAI data channel rejected the tool result",
      ),
    );
    transport.stop();
  });

  it("silently disposes a provisional OpenAI transport", async () => {
    const onTalkEvent = vi.fn();
    const { transport } = await createWebRtcTransport({ callbacks: { onTalkEvent } });
    await transport.start();
    onTalkEvent.mockClear();

    transport.stop({ emitClosed: false });

    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(FakePeerConnection.instances[0]?.connectionState).toBe("closed");
  });

  it.each([
    ["close_requested", "idle"],
    ["content", "error"],
    ["connection_lost", "error"],
  ])(
    "displays GPT-Live transcript fragments and releases media on %s finalization",
    async (reason, outcome) => {
      const { peer, onTranscript, onTalkEvent, onStatus } = await startWebRtcTransport();
      const dispatch = (event: unknown) => dispatchRealtimeEvent(peer, event);

      dispatch({
        type: "session.input_transcript.delta",
        delta: "Check the weather",
      });
      dispatch({
        type: "session.output_transcript.delta",
        delta: "I'll check",
      });

      expect(onTranscript.mock.calls.map(([entry]) => entry)).toEqual([
        { role: "user", text: "Check the weather", final: false, textMode: "verbatim" },
        { role: "assistant", text: "I'll check", final: false, textMode: "verbatim" },
      ]);
      expect(onTalkEvent).not.toHaveBeenCalled();
      expect(peer.connectionState).not.toBe("closed");

      dispatch({ type: "session.delegation.created" });
      dispatch({ type: "session.closed", reason });
      dispatch({ type: "session.input_transcript.delta", delta: "stale" });

      expect(peer?.connectionState).toBe("closed");
      expect(peer.channel.close).toHaveBeenCalledOnce();
      expect(stopInputTrack).toHaveBeenCalledOnce();
      if (outcome === "error") {
        expect(onStatus).toHaveBeenLastCalledWith("error", "Realtime connection closed");
      } else {
        expect(onStatus).toHaveBeenLastCalledWith("idle");
      }
      expect(onTranscript).toHaveBeenCalledTimes(2);
      expect(onTranscript.mock.calls.some(([entry]) => entry.final)).toBe(false);
      expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
    },
  );

  it("stops an assistant turn event when its transcript callback closes the transport", async () => {
    const transportRef: { current?: WebRtcSdpRealtimeTalkTransport } = {};
    const onTranscript = vi.fn(() => transportRef.current?.stop());
    const { transport, peer, onStatus, onTalkEvent } = await startWebRtcTransport(
      {},
      { onTranscript },
    );
    transportRef.current = transport;
    onStatus.mockClear();
    onTalkEvent.mockClear();

    dispatchRealtimeEvent(peer, {
      type: "turn.done",
      turn: { id: "assistant-final", role: "assistant", transcript: "finished" },
    });

    expect(onTranscript).toHaveBeenCalledOnce();
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent.mock.calls.map(([event]) => event.type)).toEqual(["session.closed"]);
  });
});
