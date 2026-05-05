import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TalkEvent } from "../../realtime-voice/talk-events.js";
import { createTalkSessionController } from "../../realtime-voice/talk-session-controller.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { resolveRealtimeSenderIsOwner, VoiceClawRealtimeSession } from "./session.js";
import type {
  VoiceClawRealtimeAdapter,
  VoiceClawServerEvent,
  VoiceClawSessionConfigEvent,
} from "./types.js";

describe("resolveRealtimeSenderIsOwner", () => {
  it("allows only owner-equivalent realtime brain auth", () => {
    expect(resolveRealtimeSenderIsOwner("token", false)).toBe(true);
    expect(resolveRealtimeSenderIsOwner("password", false)).toBe(true);
    expect(resolveRealtimeSenderIsOwner("none", true)).toBe(true);

    expect(resolveRealtimeSenderIsOwner("none", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("trusted-proxy", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("tailscale", false)).toBe(false);
    expect(resolveRealtimeSenderIsOwner("device-token", false)).toBe(false);
  });
});

class FakeWebSocket extends EventEmitter {
  readyState: WebSocket["readyState"] = WebSocket.OPEN;
  sent: unknown[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as unknown);
  }

  close(code?: number, reason?: string | Buffer): void {
    this.closeCode = code;
    this.closeReason = typeof reason === "string" ? reason : reason?.toString("utf8");
    this.readyState = WebSocket.CLOSING;
    this.emit("close");
  }
}

function makeAdapter(): VoiceClawRealtimeAdapter {
  return {
    connect: vi.fn(),
    sendAudio: vi.fn(),
    commitAudio: vi.fn(),
    sendFrame: vi.fn(),
    createResponse: vi.fn(),
    cancelResponse: vi.fn(),
    beginAsyncToolCall: vi.fn(),
    finishAsyncToolCall: vi.fn(),
    sendToolResult: vi.fn(),
    injectContext: vi.fn(),
    getTranscript: vi.fn(() => [{ role: "user" as const, text: "hello" }]),
    disconnect: vi.fn(),
  };
}

describe("VoiceClawRealtimeSession lifecycle", () => {
  it("rejects request-time instructionsOverride", async () => {
    const ws = new FakeWebSocket();
    const adapter = makeAdapter();
    const releasePreauthBudget = vi.fn();
    const session = new VoiceClawRealtimeSession({
      ws: ws as unknown as WebSocket,
      req: {} as IncomingMessage,
      auth: { mode: "none" } as ResolvedGatewayAuth,
      config: {} as OpenClawConfig,
      trustedProxies: [],
      allowRealIpFallback: false,
      releasePreauthBudget,
      adapterFactory: () => adapter,
    });

    session.attach();
    ws.emit(
      "message",
      JSON.stringify({
        type: "session.config",
        brainAgent: "none",
        instructionsOverride: "custom request-time instructions",
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(ws.sent).toEqual([
      {
        type: "error",
        message: "request-time instructionsOverride is not supported",
        code: 400,
      },
    ]);
    expect(ws.closeCode).toBe(1008);
    expect(ws.closeReason).toBe("unsupported instruction override");
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(releasePreauthBudget).toHaveBeenCalledOnce();
  });

  it("sends session summary before closing after terminal adapter errors", () => {
    const ws = new FakeWebSocket();
    const adapter = makeAdapter();
    const releasePreauthBudget = vi.fn();
    const session = new VoiceClawRealtimeSession({
      ws: ws as unknown as WebSocket,
      req: {} as IncomingMessage,
      auth: { mode: "none" } as ResolvedGatewayAuth,
      config: {} as OpenClawConfig,
      trustedProxies: [],
      allowRealIpFallback: false,
      releasePreauthBudget,
      adapterFactory: () => adapter,
    });
    const internals = session as unknown as {
      adapter: VoiceClawRealtimeAdapter;
      config: VoiceClawSessionConfigEvent;
      handleAdapterEvent(event: VoiceClawServerEvent): void;
    };
    internals.adapter = adapter;
    internals.config = { type: "session.config", brainAgent: "none" };

    internals.handleAdapterEvent({
      type: "error",
      message: "Gemini Live reconnect failed",
      code: 502,
    });

    expect(ws.sent).toEqual([
      { type: "error", message: "Gemini Live reconnect failed", code: 502 },
      {
        type: "session.ended",
        summary: "Real-time brain session ended.",
        durationSec: expect.any(Number),
        turnCount: 1,
      },
    ]);
    expect(ws.closeCode).toBe(1011);
    expect(ws.closeReason).toBe("upstream error");
    expect(adapter.disconnect).toHaveBeenCalledOnce();
    expect(releasePreauthBudget).toHaveBeenCalledOnce();
  });

  it("adds common Talk event envelopes to configured server events", () => {
    const ws = new FakeWebSocket();
    const adapter = makeAdapter();
    const session = new VoiceClawRealtimeSession({
      ws: ws as unknown as WebSocket,
      req: {} as IncomingMessage,
      auth: { mode: "none" } as ResolvedGatewayAuth,
      config: {} as OpenClawConfig,
      trustedProxies: [],
      allowRealIpFallback: false,
      releasePreauthBudget: vi.fn(),
      adapterFactory: () => adapter,
    });
    const internals = session as unknown as {
      config: VoiceClawSessionConfigEvent;
      talk: unknown;
      handleAdapterEvent(event: VoiceClawServerEvent): void;
    };
    internals.config = { type: "session.config", brainAgent: "none", provider: "gemini" };
    internals.talk = createTalkSessionController({
      sessionId: "voice-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "direct-tools",
      provider: "gemini",
    });

    internals.handleAdapterEvent({
      type: "transcript.done",
      role: "assistant",
      text: "hello",
    });

    expect(ws.sent).toEqual([
      expect.objectContaining({
        type: "transcript.done",
        talkEvent: expect.objectContaining({
          type: "output.text.done",
          sessionId: "voice-session",
          mode: "realtime",
          transport: "gateway-relay",
          brain: "direct-tools",
          provider: "gemini",
          final: true,
          payload: { role: "assistant", text: "hello" },
        }),
      }),
    ]);
  });

  it("keeps streamed output audio out of common Talk event payloads", () => {
    const ws = new FakeWebSocket();
    const adapter = makeAdapter();
    const session = new VoiceClawRealtimeSession({
      ws: ws as unknown as WebSocket,
      req: {} as IncomingMessage,
      auth: { mode: "none" } as ResolvedGatewayAuth,
      config: {} as OpenClawConfig,
      trustedProxies: [],
      allowRealIpFallback: false,
      releasePreauthBudget: vi.fn(),
      adapterFactory: () => adapter,
    });
    const internals = session as unknown as {
      config: VoiceClawSessionConfigEvent;
      talk: unknown;
      handleAdapterEvent(event: VoiceClawServerEvent): void;
    };
    const audioData = Buffer.from("hello").toString("base64");
    internals.config = { type: "session.config", brainAgent: "none", provider: "gemini" };
    internals.talk = createTalkSessionController({
      sessionId: "voice-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "direct-tools",
      provider: "gemini",
    });

    internals.handleAdapterEvent({
      type: "audio.delta",
      data: audioData,
    });

    expect(ws.sent).toEqual([
      expect.objectContaining({
        type: "audio.delta",
        data: audioData,
        talkEvent: expect.objectContaining({
          type: "output.audio.delta",
          payload: { byteLength: 5 },
        }),
      }),
    ]);
    expect(
      (ws.sent[0] as { talkEvent?: { payload?: Record<string, unknown> } }).talkEvent?.payload,
    ).not.toHaveProperty("data");
  });

  it("emits common Talk events for client audio, video, cancellation, and tool results", async () => {
    const ws = new FakeWebSocket();
    const adapter = makeAdapter();
    const talkEvents: TalkEvent[] = [];
    const session = new VoiceClawRealtimeSession({
      ws: ws as unknown as WebSocket,
      req: {} as IncomingMessage,
      auth: { mode: "none" } as ResolvedGatewayAuth,
      config: {} as OpenClawConfig,
      trustedProxies: [],
      allowRealIpFallback: false,
      releasePreauthBudget: vi.fn(),
      adapterFactory: () => adapter,
      onTalkEvent: (event) => talkEvents.push(event),
    });
    const internals = session as unknown as {
      adapter: VoiceClawRealtimeAdapter;
      config: VoiceClawSessionConfigEvent;
      talk: ReturnType<typeof createTalkSessionController>;
      handleRawMessage(raw: string): Promise<void>;
    };
    internals.adapter = adapter;
    internals.config = { type: "session.config", brainAgent: "none", provider: "gemini" };
    internals.talk = createTalkSessionController({
      sessionId: "voice-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "direct-tools",
      provider: "gemini",
    });
    internals.talk.startTurn({ turnId: "turn-client" });

    await internals.handleRawMessage(
      JSON.stringify({ type: "audio.append", data: Buffer.from("hello").toString("base64") }),
    );
    await internals.handleRawMessage(JSON.stringify({ type: "audio.commit" }));
    await internals.handleRawMessage(
      JSON.stringify({
        type: "frame.append",
        data: Buffer.from("frame").toString("base64"),
        mimeType: "image/jpeg",
      }),
    );
    await internals.handleRawMessage(JSON.stringify({ type: "response.cancel" }));
    await internals.handleRawMessage(
      JSON.stringify({ type: "tool.result", callId: "call-1", output: "done" }),
    );

    expect(adapter.sendAudio).toHaveBeenCalledWith(Buffer.from("hello").toString("base64"));
    expect(adapter.commitAudio).toHaveBeenCalledOnce();
    expect(adapter.sendFrame).toHaveBeenCalledWith(
      Buffer.from("frame").toString("base64"),
      "image/jpeg",
    );
    expect(adapter.cancelResponse).toHaveBeenCalledOnce();
    expect(adapter.sendToolResult).toHaveBeenCalledWith("call-1", "done");
    expect(talkEvents.map((event) => event.type)).toEqual([
      "input.audio.delta",
      "input.audio.committed",
      "health.changed",
      "turn.cancelled",
      "turn.started",
      "tool.result",
    ]);
    expect(talkEvents).toEqual([
      expect.objectContaining({
        type: "input.audio.delta",
        turnId: "turn-client",
        payload: { byteLength: 5 },
      }),
      expect.objectContaining({
        type: "input.audio.committed",
        turnId: "turn-client",
        final: true,
      }),
      expect.objectContaining({
        type: "health.changed",
        payload: { inputVideoFrame: true, mimeType: "image/jpeg", byteLength: 5 },
      }),
      expect.objectContaining({
        type: "turn.cancelled",
        payload: { reason: "client-cancelled" },
        final: true,
      }),
      expect.objectContaining({
        type: "turn.started",
        payload: { source: "implicit" },
      }),
      expect.objectContaining({
        type: "tool.result",
        callId: "call-1",
        payload: { output: "done" },
        final: true,
      }),
    ]);
  });
});
