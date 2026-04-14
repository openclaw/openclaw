import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachOpenClawTranscriptMeta: vi.fn(),
  loadGatewaySessionRow: vi.fn(),
  loadSessionEntry: vi.fn(),
  readSessionMessages: vi.fn(),
  resolveSessionKeyForTranscriptFile: vi.fn(),
}));

vi.mock("./session-transcript-key.js", () => ({
  resolveSessionKeyForTranscriptFile: mocks.resolveSessionKeyForTranscriptFile,
}));

vi.mock("./session-utils.js", () => ({
  attachOpenClawTranscriptMeta: mocks.attachOpenClawTranscriptMeta,
  loadGatewaySessionRow: mocks.loadGatewaySessionRow,
  loadSessionEntry: mocks.loadSessionEntry,
  readSessionMessages: mocks.readSessionMessages,
}));

import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveSessionKeyForTranscriptFile.mockReturnValue("agent:main:main");
    mocks.loadSessionEntry.mockReturnValue({
      entry: {
        sessionId: "sess-main",
        sessionFile: "/tmp/sess-main.jsonl",
      },
      storePath: "/tmp/sessions.json",
    });
    mocks.readSessionMessages.mockReturnValue([{}, {}]);
    mocks.loadGatewaySessionRow.mockReturnValue({
      sessionId: "sess-main",
      updatedAt: 123,
      kind: "agent",
      label: "Main",
    });
    mocks.attachOpenClawTranscriptMeta.mockImplementation(
      (message: Record<string, unknown>, meta: Record<string, unknown>) => ({
        ...message,
        openclawMeta: meta,
      }),
    );
  });

  function createHarness() {
    const broadcastToConnIds = vi.fn();
    const sessionEventSubscribers = {
      getAll: vi.fn(() => new Set(["conn-event"])),
    };
    const sessionMessageSubscribers = {
      get: vi.fn((sessionKey: string) =>
        sessionKey === "agent:main:main" ? new Set(["conn-message"]) : new Set<string>(),
      ),
    };
    return {
      broadcastToConnIds,
      handler: createTranscriptUpdateBroadcastHandler({
        broadcastToConnIds,
        sessionEventSubscribers,
        sessionMessageSubscribers,
      }),
      sessionEventSubscribers,
      sessionMessageSubscribers,
    };
  }

  it("suppresses commentary-only assistant transcript updates from session.message", () => {
    const { broadcastToConnIds, handler } = createHarness();

    handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Thinking out loud",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
          },
        ],
        timestamp: 1,
      },
      messageId: "msg-commentary",
    });

    expect(mocks.attachOpenClawTranscriptMeta).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds.mock.calls[0]?.[0]).toBe("sessions.changed");
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        phase: "message",
        messageId: "msg-commentary",
        messageSeq: 2,
      }),
    );
    expect(Array.from(broadcastToConnIds.mock.calls[0]?.[2] as Set<string>)).toEqual([
      "conn-event",
    ]);
  });

  it("suppresses mixed commentary transcript updates from session.message", () => {
    const { broadcastToConnIds, handler } = createHarness();

    handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: "agent:main:main",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Checking logs before I call the tool.",
            textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
          },
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
        timestamp: 1,
      },
      messageId: "msg-commentary-tool",
    });

    expect(mocks.attachOpenClawTranscriptMeta).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds.mock.calls[0]?.[0]).toBe("sessions.changed");
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        messageId: "msg-commentary-tool",
        messageSeq: 2,
        phase: "message",
      }),
    );
    expect(Array.from(broadcastToConnIds.mock.calls[0]?.[2] as Set<string>)).toEqual([
      "conn-event",
    ]);
  });
});
