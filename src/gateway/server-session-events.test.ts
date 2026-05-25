import { describe, expect, it, vi } from "vitest";

const resolveSessionKeyForTranscriptFileMock = vi.hoisted(() => vi.fn());
const projectChatDisplayMessageMock = vi.hoisted(() => vi.fn((message: unknown) => message));
const attachOpenClawTranscriptMetaMock = vi.hoisted(() => vi.fn((message: unknown) => message));
const loadGatewaySessionRowMock = vi.hoisted(() => vi.fn());
const loadSessionEntryMock = vi.hoisted(() => vi.fn());
const readSessionMessageCountAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("./session-transcript-key.js", () => ({
  resolveSessionKeyForTranscriptFile: resolveSessionKeyForTranscriptFileMock,
}));

vi.mock("./chat-display-projection.js", () => ({
  projectChatDisplayMessage: projectChatDisplayMessageMock,
}));

vi.mock("./session-utils.js", () => ({
  attachOpenClawTranscriptMeta: attachOpenClawTranscriptMetaMock,
  loadGatewaySessionRow: loadGatewaySessionRowMock,
  loadSessionEntry: loadSessionEntryMock,
  readSessionMessageCountAsync: readSessionMessageCountAsyncMock,
}));

import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";

describe("createTranscriptUpdateBroadcastHandler", () => {
  it("does not resolve a missing transcript path without an explicit session key", async () => {
    const broadcastToConnIds = vi.fn();
    const sessionEventSubscribers = {
      getAll: vi.fn(() => new Set<string>(["operator-events"])),
    };
    const sessionMessageSubscribers = {
      get: vi.fn(() => new Set<string>(["operator-message"])),
    };
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers,
      sessionMessageSubscribers,
    });

    handler({
      sessionFile: `/tmp/openclaw-missing-${Date.now()}.jsonl`,
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveSessionKeyForTranscriptFileMock).not.toHaveBeenCalled();
    expect(sessionEventSubscribers.getAll).not.toHaveBeenCalled();
    expect(sessionMessageSubscribers.get).not.toHaveBeenCalled();
    expect(loadSessionEntryMock).not.toHaveBeenCalled();
    expect(readSessionMessageCountAsyncMock).not.toHaveBeenCalled();
    expect(projectChatDisplayMessageMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });
});
