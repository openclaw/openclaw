/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../gateway.ts";
import { RealtimeTalkSession, type RealtimeTalkSessionResult } from "./realtime-talk.ts";

type Listener = (evt: GatewayEventFrame) => void;

class MockGatewayClient {
  readonly listeners = new Set<Listener>();
  readonly request = vi.fn();

  addEventListener(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(evt: GatewayEventFrame): void {
    for (const listener of this.listeners) {
      listener(evt);
    }
  }
}

type MockWebSocketHandler = (event?: { data?: string }) => void;

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly sent: unknown[] = [];
  readonly handlers = new Map<string, MockWebSocketHandler[]>();
  readyState = 0;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, handler: MockWebSocketHandler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    for (const handler of this.handlers.get("open") ?? []) {
      handler();
    }
  }

  message(data: unknown): void {
    for (const handler of this.handlers.get("message") ?? []) {
      handler({ data: JSON.stringify(data) });
    }
  }
}

class MockAudioContext {
  sampleRate = 16_000;
  currentTime = 0;
  destination = {};

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    return { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => data,
    };
  }

  createBufferSource() {
    return {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      addEventListener: vi.fn(),
    };
  }

  close = vi.fn(async () => {});
}

describe("RealtimeTalkSession Google Live", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("AudioContext", MockAudioContext);
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(async () => ({
          getAudioTracks: () => [],
          getTracks: () => [],
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens Google Live WebSocket sessions and preserves tool call id/name in responses", async () => {
    const client = new MockGatewayClient();
    const googleSession: RealtimeTalkSessionResult = {
      provider: "google",
      transport: "google-live-websocket",
      clientSecret: "auth_tokens/browser-token",
      websocketUrl:
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained",
      googleLiveSetup: {
        model: "models/gemini-live",
        generationConfig: { responseModalities: ["AUDIO"] },
      },
    };
    client.request.mockImplementation(async (method: string) => {
      if (method === "talk.realtime.session") {
        return googleSession;
      }
      if (method === "chat.send") {
        return { runId: "run-1" };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const talk = new RealtimeTalkSession(client as never, "main");
    await talk.start();
    const ws = MockWebSocket.instances.at(-1);
    expect(ws?.url).toBe(`${googleSession.websocketUrl}?access_token=auth_tokens%2Fbrowser-token`);

    ws?.open();
    expect(ws?.sent).toContainEqual({ setup: googleSession.googleLiveSetup });

    ws?.message({
      toolCall: {
        functionCalls: [
          {
            id: "call-1",
            name: "openclaw_agent_consult",
            args: { question: "What is the basement light status?" },
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(client.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({ sessionKey: "main" }),
      );
    });

    client.emit({
      event: "chat",
      payload: {
        runId: "run-1",
        state: "final",
        message: { text: "The basement lights are off." },
      },
    } as GatewayEventFrame);

    await vi.waitFor(() => {
      expect(ws?.sent).toContainEqual({
        toolResponse: {
          functionResponses: [
            {
              id: "call-1",
              name: "openclaw_agent_consult",
              response: { result: "The basement lights are off." },
              scheduling: "WHEN_IDLE",
            },
          ],
        },
      });
    });

    talk.stop();
  });
});
