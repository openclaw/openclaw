import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { VoiceClawGeminiLiveAdapter } from "./gemini-live.js";
import {
  createDefaultAdapterFactory,
  defaultVoiceFor,
  requiredApiKeyEnvFor,
  resolveProvider,
  resolveRealtimeSenderIsOwner,
  VoiceClawRealtimeSession,
} from "./session.js";
import type {
  VoiceClawRealtimeAdapter,
  VoiceClawServerEvent,
  VoiceClawSessionConfigEvent,
} from "./types.js";
import { VoiceClawXaiRealtimeAdapter } from "./xai-realtime.js";

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

describe("realtime brain provider selection", () => {
  it("defaults to gemini when no provider is specified (back-compat)", () => {
    expect(resolveProvider(undefined)).toBe("gemini");
    expect(resolveProvider("gemini")).toBe("gemini");
    // openai is reserved in the type union but not yet wired in /voiceclaw/realtime;
    // resolveProvider falls back to gemini for any non-xai value.
    expect(resolveProvider("openai")).toBe("gemini");
  });

  it("resolves provider='xai' to the xAI realtime brain", () => {
    expect(resolveProvider("xai")).toBe("xai");
  });

  it("returns ara as the xAI default voice and Zephyr as the Gemini default", () => {
    expect(defaultVoiceFor("xai")).toBe("ara");
    expect(defaultVoiceFor("gemini")).toBe("Zephyr");
  });

  it("requires the correct API key env per provider", () => {
    expect(requiredApiKeyEnvFor("xai")).toBe("XAI_API_KEY");
    expect(requiredApiKeyEnvFor("gemini")).toBe("GEMINI_API_KEY");
  });

  it("default adapter factory dispatches by provider", () => {
    const factory = createDefaultAdapterFactory();
    const xaiAdapter = factory({ type: "session.config", provider: "xai" });
    const geminiAdapter = factory({ type: "session.config", provider: "gemini" });
    const undefinedAdapter = factory({ type: "session.config" });
    expect(xaiAdapter).toBeInstanceOf(VoiceClawXaiRealtimeAdapter);
    expect(geminiAdapter).toBeInstanceOf(VoiceClawGeminiLiveAdapter);
    expect(undefinedAdapter).toBeInstanceOf(VoiceClawGeminiLiveAdapter);
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
});
