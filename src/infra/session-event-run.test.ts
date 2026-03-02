import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { loadSessionEntry as loadSessionEntryType } from "../gateway/session-utils.js";

const {
  dispatchInboundMessageWithDispatcherMock,
  createReplyPrefixOptionsMock,
  loadSessionEntryMock,
  routeReplyMock,
  hasSystemEventsMock,
  getQueueSizeMock,
} = vi.hoisted(() => ({
  dispatchInboundMessageWithDispatcherMock: vi.fn(async (_params: unknown) => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
  createReplyPrefixOptionsMock: vi.fn(() => ({
    responsePrefix: undefined,
    responsePrefixContextProvider: () => ({ identityName: "OpenClaw" }),
    onModelSelected: vi.fn(),
  })),
  hasSystemEventsMock: vi.fn(() => true),
  getQueueSizeMock: vi.fn(() => 0),
  loadSessionEntryMock: vi.fn(
    (sessionKey: string): ReturnType<typeof loadSessionEntryType> => ({
      cfg: { session: { mainKey: "agent:main:main" } } as OpenClawConfig,
      storePath: "/tmp/sessions.json",
      store: {},
      entry: {
        sessionId: `sid-${sessionKey}`,
        updatedAt: Date.now(),
        lastChannel: "telegram",
        lastTo: "123",
        lastAccountId: "acct-1",
        lastThreadId: "topic-1",
      },
      canonicalKey: sessionKey,
      legacyKey: undefined,
    }),
  ),
  routeReplyMock: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithDispatcher: dispatchInboundMessageWithDispatcherMock,
}));
vi.mock("../channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: createReplyPrefixOptionsMock,
}));
vi.mock("../gateway/session-utils.js", () => ({
  loadSessionEntry: loadSessionEntryMock,
}));
vi.mock("../auto-reply/reply/route-reply.js", () => ({
  routeReply: routeReplyMock,
}));
vi.mock("./system-events.js", () => ({
  hasSystemEvents: hasSystemEventsMock,
}));
vi.mock("../process/command-queue.js", () => ({
  getQueueSize: getQueueSizeMock,
}));
vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

import {
  requestSessionEventRun,
  resetSessionEventRunStateForTests,
  triggerSessionEventRun,
} from "./session-event-run.js";

describe("triggerSessionEventRun", () => {
  beforeEach(() => {
    vi.useRealTimers();
    dispatchInboundMessageWithDispatcherMock.mockClear();
    createReplyPrefixOptionsMock.mockClear();
    loadSessionEntryMock.mockClear();
    hasSystemEventsMock.mockReset();
    hasSystemEventsMock.mockReturnValue(true);
    getQueueSizeMock.mockReset();
    getQueueSizeMock.mockReturnValue(0);
    routeReplyMock.mockReset();
    routeReplyMock.mockResolvedValue({ ok: true });
    resetSessionEventRunStateForTests();
    loadSessionEntryMock.mockImplementation(
      (sessionKey: string): ReturnType<typeof loadSessionEntryType> => ({
        cfg: { session: { mainKey: "agent:main:main" } } as OpenClawConfig,
        storePath: "/tmp/sessions.json",
        store: {},
        entry: {
          sessionId: `sid-${sessionKey}`,
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "123",
          lastAccountId: "acct-1",
          lastThreadId: "topic-1",
        },
        canonicalKey: sessionKey,
        legacyKey: undefined,
      }),
    );
  });

  it("dispatches a normal inbound run for agent sessions", async () => {
    const triggered = await triggerSessionEventRun({
      sessionKey: "agent:ops:main",
      source: "exec-event",
      agentId: "ops",
    });

    expect(triggered).toBe(true);
    expect(dispatchInboundMessageWithDispatcherMock).toHaveBeenCalledTimes(1);
    const [call] = dispatchInboundMessageWithDispatcherMock.mock.calls;
    const params = call?.[0] as
      | {
          ctx?: Record<string, unknown>;
          replyOptions?: Record<string, unknown>;
        }
      | undefined;
    expect(params?.ctx?.SessionKey).toBe("agent:ops:main");
    expect(params?.ctx?.Surface).toBe("webchat");
    expect(params?.ctx?.OriginatingChannel).toBe("telegram");
    expect(params?.ctx?.OriginatingTo).toBe("123");
    expect(typeof params?.ctx?.MessageSid).toBe("string");
    expect(params?.ctx?.MessageSid).toMatch(/^exec-event:/);
    expect(params?.replyOptions).toMatchObject({
      suppressTyping: true,
      allowEmptyBodyForSystemEvent: true,
    });
  });

  it("routes dispatcher deliveries to the session origin", async () => {
    dispatchInboundMessageWithDispatcherMock.mockImplementationOnce(async (raw) => {
      const params = raw as {
        dispatcherOptions?: {
          deliver?: (payload: { text?: string }, info: { kind: "final" }) => Promise<void>;
        };
      };
      await params.dispatcherOptions?.deliver?.(
        { text: "exec completion acknowledged" },
        { kind: "final" },
      );
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    });

    const triggered = await triggerSessionEventRun({
      sessionKey: "agent:ops:main",
      source: "exec-event",
      agentId: "ops",
    });

    expect(triggered).toBe(true);
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "exec completion acknowledged" },
        channel: "telegram",
        to: "123",
        sessionKey: "agent:ops:main",
      }),
    );
  });

  it("uses canonical agent keys from session lookup", async () => {
    loadSessionEntryMock.mockImplementationOnce(
      (_sessionKey: string): ReturnType<typeof loadSessionEntryType> => ({
        cfg: { session: { mainKey: "agent:ops:work" } } as OpenClawConfig,
        storePath: "/tmp/sessions.json",
        store: {},
        entry: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "discord",
          lastTo: "C123",
        },
        canonicalKey: "agent:ops:work",
        legacyKey: "main",
      }),
    );

    const triggered = await triggerSessionEventRun({
      sessionKey: "main",
      source: "exec-event",
    });

    expect(triggered).toBe(true);
    const [call] = dispatchInboundMessageWithDispatcherMock.mock.calls;
    const params = call?.[0] as { ctx?: Record<string, unknown> } | undefined;
    expect(params?.ctx?.SessionKey).toBe("agent:ops:work");
    expect(params?.ctx?.OriginatingChannel).toBe("discord");
    expect(params?.ctx?.OriginatingTo).toBe("C123");
  });

  it("falls back to the requested key when only the raw key has queued events", async () => {
    loadSessionEntryMock.mockImplementationOnce(
      (_sessionKey: string): ReturnType<typeof loadSessionEntryType> => ({
        cfg: { session: { mainKey: "agent:ops:work" } } as OpenClawConfig,
        storePath: "/tmp/sessions.json",
        store: {},
        entry: {
          sessionId: "sid-main",
          updatedAt: Date.now(),
          lastChannel: "discord",
          lastTo: "C123",
        },
        canonicalKey: "agent:ops:work",
        legacyKey: "main",
      }),
    );
    hasSystemEventsMock.mockImplementation((key: string) => key === "main");

    const triggered = await triggerSessionEventRun({
      sessionKey: "main",
      source: "exec-event",
    });

    expect(triggered).toBe(true);
    const [call] = dispatchInboundMessageWithDispatcherMock.mock.calls;
    const params = call?.[0] as { ctx?: Record<string, unknown> } | undefined;
    expect(params?.ctx?.SessionKey).toBe("main");
  });

  it("queues a follow-up run when canonical and alias queues both have events", async () => {
    vi.useFakeTimers();
    loadSessionEntryMock.mockImplementation(
      (inputKey: string): ReturnType<typeof loadSessionEntryType> => ({
        cfg: { session: { mainKey: "agent:ops:work" } } as OpenClawConfig,
        storePath: "/tmp/sessions.json",
        store: {},
        entry: {
          sessionId: `sid-${inputKey}`,
          updatedAt: Date.now(),
          lastChannel: "discord",
          lastTo: "C123",
        },
        canonicalKey: "agent:ops:work",
        legacyKey: inputKey === "main" ? "main" : undefined,
      }),
    );

    const pendingByKey = new Set(["agent:ops:work", "main"]);
    hasSystemEventsMock.mockImplementation((key: string) => pendingByKey.has(key));
    dispatchInboundMessageWithDispatcherMock.mockImplementation(async (raw) => {
      const params = raw as { ctx?: { SessionKey?: string } };
      const key = params.ctx?.SessionKey;
      if (typeof key === "string") {
        pendingByKey.delete(key);
      }
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    });

    requestSessionEventRun({
      sessionKey: "main",
      source: "exec-event",
    });

    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);

    const dispatchedSessionKeys = dispatchInboundMessageWithDispatcherMock.mock.calls.map(
      (call) => (call[0] as { ctx?: { SessionKey?: string } })?.ctx?.SessionKey,
    );
    expect(dispatchedSessionKeys).toEqual(["agent:ops:work", "main"]);
    expect(pendingByKey.size).toBe(0);
  });

  it("skips non-agent canonical session keys", async () => {
    loadSessionEntryMock.mockImplementationOnce(
      (_sessionKey: string): ReturnType<typeof loadSessionEntryType> => ({
        cfg: { session: { mainKey: "agent:main:main" } } as OpenClawConfig,
        storePath: "/tmp/sessions.json",
        store: {},
        entry: {
          sessionId: "sid-global",
          updatedAt: Date.now(),
        },
        canonicalKey: "global",
        legacyKey: undefined,
      }),
    );

    const triggered = await triggerSessionEventRun({
      sessionKey: "global",
      source: "exec-event",
    });

    expect(triggered).toBe(false);
    expect(dispatchInboundMessageWithDispatcherMock).not.toHaveBeenCalled();
  });

  it("skips dispatch when there are no queued system events", async () => {
    hasSystemEventsMock.mockReturnValue(false);

    const triggered = await triggerSessionEventRun({
      sessionKey: "agent:ops:main",
      source: "exec-event",
    });

    expect(triggered).toBe(false);
    expect(dispatchInboundMessageWithDispatcherMock).not.toHaveBeenCalled();
  });

  it("skips dispatch while the main lane has requests in flight", async () => {
    getQueueSizeMock.mockReturnValue(1);

    const triggered = await triggerSessionEventRun({
      sessionKey: "agent:ops:main",
      source: "exec-event",
    });

    expect(triggered).toBe(false);
    expect(dispatchInboundMessageWithDispatcherMock).not.toHaveBeenCalled();
  });

  it("coalesces duplicate wake requests and retries once the main lane clears", async () => {
    vi.useFakeTimers();
    getQueueSizeMock.mockReturnValueOnce(1).mockReturnValue(0);

    requestSessionEventRun({
      sessionKey: "agent:ops:main",
      source: "exec-event",
      agentId: "ops",
    });
    requestSessionEventRun({
      sessionKey: "agent:ops:main",
      source: "exec-event",
      agentId: "ops",
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(dispatchInboundMessageWithDispatcherMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatchInboundMessageWithDispatcherMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces duplicate wake requests for the same session even when agentId differs", async () => {
    vi.useFakeTimers();

    requestSessionEventRun({
      sessionKey: "agent:ops:main",
      source: "exec-event",
      agentId: "ops",
    });
    requestSessionEventRun({
      sessionKey: "agent:ops:main",
      source: "exec-event",
      agentId: undefined,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(dispatchInboundMessageWithDispatcherMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry skipped non-agent session requests", async () => {
    vi.useFakeTimers();
    loadSessionEntryMock.mockImplementationOnce(
      (_sessionKey: string): ReturnType<typeof loadSessionEntryType> => ({
        cfg: { session: { mainKey: "agent:main:main" } } as OpenClawConfig,
        storePath: "/tmp/sessions.json",
        store: {},
        entry: {
          sessionId: "sid-global",
          updatedAt: Date.now(),
        },
        canonicalKey: "global",
        legacyKey: undefined,
      }),
    );

    requestSessionEventRun({
      sessionKey: "global",
      source: "exec-event",
    });

    await vi.advanceTimersByTimeAsync(2500);
    expect(dispatchInboundMessageWithDispatcherMock).not.toHaveBeenCalled();
    expect(loadSessionEntryMock).toHaveBeenCalledTimes(1);
  });

  it("continues draining other sessions when one run throws, then retries the failed target", async () => {
    vi.useFakeTimers();
    let failedOnce = false;
    dispatchInboundMessageWithDispatcherMock.mockImplementation(async (raw) => {
      const params = raw as { ctx?: { SessionKey?: string } };
      if (params.ctx?.SessionKey === "agent:ops:fail" && !failedOnce) {
        failedOnce = true;
        throw new Error("synthetic dispatch failure");
      }
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    });

    requestSessionEventRun({
      sessionKey: "agent:ops:fail",
      source: "exec-event",
    });
    requestSessionEventRun({
      sessionKey: "agent:ops:ok",
      source: "exec-event",
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(dispatchInboundMessageWithDispatcherMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      dispatchInboundMessageWithDispatcherMock.mock.calls.some(
        (call) =>
          (call[0] as { ctx?: { SessionKey?: string } })?.ctx?.SessionKey === "agent:ops:ok",
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatchInboundMessageWithDispatcherMock).toHaveBeenCalledTimes(3);
    expect(
      dispatchInboundMessageWithDispatcherMock.mock.calls.filter(
        (call) =>
          (call[0] as { ctx?: { SessionKey?: string } })?.ctx?.SessionKey === "agent:ops:fail",
      ).length,
    ).toBe(2);
  });

  it("times out a hung dispatch and continues draining queued runs", async () => {
    vi.useFakeTimers();
    dispatchInboundMessageWithDispatcherMock
      .mockImplementationOnce(
        async (_raw) =>
          await new Promise<never>(() => {
            // Simulate an upstream hang that never resolves.
          }),
      )
      .mockImplementation(async (_raw) => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      }));

    requestSessionEventRun({
      sessionKey: "agent:ops:hang",
      source: "exec-event",
    });
    await vi.advanceTimersByTimeAsync(250);

    requestSessionEventRun({
      sessionKey: "agent:ops:next",
      source: "exec-event",
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(1_250);

    expect(dispatchInboundMessageWithDispatcherMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(
      dispatchInboundMessageWithDispatcherMock.mock.calls.some(
        (call) =>
          (call[0] as { ctx?: { SessionKey?: string } })?.ctx?.SessionKey === "agent:ops:next",
      ),
    ).toBe(true);
  });
});
