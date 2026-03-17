import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleGatewayEvent } from "../../ui/src/ui/app-gateway.ts";

// Minimal mock of GatewayHost — only the fields needed for chat.inbound handling
function createMockHost(overrides: { tab?: string; sessionKey?: string } = {}) {
  return {
    tab: overrides.tab ?? "chat",
    sessionKey: overrides.sessionKey ?? "agent:main:telegram:1234",
    eventLogBuffer: [] as unknown[],
    eventLog: [] as unknown[],
    // Fields required by handleGatewayEvent but not relevant to chat.inbound
    onboarding: false,
    connected: true,
    client: {
      request: vi.fn().mockResolvedValue({ messages: [] }),
    },
    chatLoading: false,
    lastError: null,
    chatMessages: [],
    chatRunId: null,
    chatStreamStartedAt: null,
  } as never;
}

describe("chat.inbound UI event handler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should not throw on chat.inbound event", () => {
    const host = createMockHost();
    expect(() =>
      handleGatewayEvent(host, {
        type: "event",
        event: "chat.inbound",
        payload: {
          sessionKey: "agent:main:telegram:1234",
          channelId: "telegram",
          timestamp: new Date().toISOString(),
        },
      }),
    ).not.toThrow();
  });

  it("should ignore chat.inbound when on a different tab", () => {
    const host = createMockHost({ tab: "overview" });
    const requestSpy = (host as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client
      .request;

    handleGatewayEvent(host, {
      type: "event",
      event: "chat.inbound",
      payload: {
        sessionKey: "agent:main:telegram:1234",
        channelId: "telegram",
        timestamp: new Date().toISOString(),
      },
    });

    vi.advanceTimersByTime(1000);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("should ignore chat.inbound when sessionKey does not match", () => {
    const host = createMockHost({ sessionKey: "agent:main:discord:5678" });
    const requestSpy = (host as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client
      .request;

    handleGatewayEvent(host, {
      type: "event",
      event: "chat.inbound",
      payload: {
        sessionKey: "agent:main:telegram:1234",
        channelId: "telegram",
        timestamp: new Date().toISOString(),
      },
    });

    vi.advanceTimersByTime(1000);
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("should debounce multiple rapid chat.inbound events", () => {
    const host = createMockHost();
    const requestSpy = (host as unknown as { client: { request: ReturnType<typeof vi.fn> } }).client
      .request;
    const evt = {
      type: "event" as const,
      event: "chat.inbound",
      payload: {
        sessionKey: "agent:main:telegram:1234",
        channelId: "telegram",
        timestamp: new Date().toISOString(),
      },
    };

    // Fire 5 rapid events
    for (let i = 0; i < 5; i++) {
      handleGatewayEvent(host, evt);
      vi.advanceTimersByTime(100); // 100ms apart
    }

    // Advance past the fast debounce window (500ms from last event)
    vi.advanceTimersByTime(500);

    // Debounce should have merged 5 events into a single loadChatHistory call
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // Advance past the slow timer (3500ms from last event, minus the 500ms
    // already elapsed = 3000ms remaining)
    vi.advanceTimersByTime(3000);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });
});
