import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionUtilsState = vi.hoisted(() => ({
  sessionRow: {
    sessionId: "sess-main",
    emotionMode: "off" as "off" | "on" | "full" | undefined,
  },
}));

vi.mock("./session-transcript-key.js", () => ({
  resolveSessionKeyForTranscriptFile: vi.fn(() => "agent:main:main"),
}));

vi.mock("./session-utils.js", () => ({
  attachOpenClawTranscriptMeta: vi.fn((message, meta) => ({ ...message, __openclaw: meta })),
  loadGatewaySessionRow: vi.fn(() => sessionUtilsState.sessionRow),
  loadSessionEntry: vi.fn(() => ({
    entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    storePath: "/tmp/sessions.json",
  })),
  readSessionMessages: vi.fn(() => []),
}));

const { createTranscriptUpdateBroadcastHandler } = await import("./server-session-events.js");

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    sessionUtilsState.sessionRow = {
      sessionId: "sess-main",
      emotionMode: "off",
    };
  });

  it("applies session emotion mode to session.message projection", () => {
    const broadcastToConnIds = vi.fn();
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["operator"]) },
      sessionMessageSubscribers: { get: () => new Set<string>() },
    });

    handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: "agent:main:main",
      messageId: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[warmly] hello" }],
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        }),
      }),
      new Set(["operator"]),
      { dropIfSlow: true },
    );
  });

  it("defaults missing session emotion mode to off for session.message projection", () => {
    sessionUtilsState.sessionRow = {
      sessionId: "sess-main",
    };
    const broadcastToConnIds = vi.fn();
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["operator"]) },
      sessionMessageSubscribers: { get: () => new Set<string>() },
    });

    handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: "agent:main:main",
      messageId: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "[warmly] hello" }],
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        message: expect.objectContaining({
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        }),
      }),
      new Set(["operator"]),
      { dropIfSlow: true },
    );
  });
});
