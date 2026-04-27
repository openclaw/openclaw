import { describe, expect, it, vi } from "vitest";

vi.mock("./session-transcript-key.js", () => ({
  resolveSessionKeyForTranscriptFile: vi.fn(() => "agent:main:main"),
}));

vi.mock("./session-utils.js", () => ({
  attachOpenClawTranscriptMeta: vi.fn((message, meta) => ({ ...message, _openclaw: meta })),
  loadGatewaySessionRow: vi.fn(() => ({
    sessionId: "sess-main",
    emotionMode: "off",
  })),
  loadSessionEntry: vi.fn(() => ({
    entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    storePath: "/tmp/sessions.json",
  })),
  readSessionMessages: vi.fn(() => []),
}));

const { createTranscriptUpdateBroadcastHandler } = await import("./server-session-events.js");

describe("createTranscriptUpdateBroadcastHandler", () => {
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
});
