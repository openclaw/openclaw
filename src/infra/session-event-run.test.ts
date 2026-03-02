import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { loadSessionEntry as loadSessionEntryType } from "../gateway/session-utils.js";

const {
  dispatchInboundMessageWithDispatcherMock,
  createReplyPrefixOptionsMock,
  loadSessionEntryMock,
  hasSystemEventsMock,
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
vi.mock("./system-events.js", () => ({
  hasSystemEvents: hasSystemEventsMock,
}));
vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

import { triggerSessionEventRun } from "./session-event-run.js";

describe("triggerSessionEventRun", () => {
  beforeEach(() => {
    dispatchInboundMessageWithDispatcherMock.mockClear();
    createReplyPrefixOptionsMock.mockClear();
    loadSessionEntryMock.mockClear();
    hasSystemEventsMock.mockReset();
    hasSystemEventsMock.mockReturnValue(true);
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
});
