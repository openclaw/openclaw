import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./controllers/chat.ts", () => ({
  abortChatRun: vi.fn().mockResolvedValue(undefined),
  loadChatHistory: vi.fn().mockResolvedValue(undefined),
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./app-scroll.ts", () => ({
  scheduleChatScroll: vi.fn(),
}));

vi.mock("./app-settings.ts", () => ({
  setLastActiveSessionKey: vi.fn(),
}));

vi.mock("./app-tool-stream.ts", () => ({
  resetToolStream: vi.fn(),
}));

vi.mock("./navigation.ts", () => ({
  normalizeBasePath: vi.fn((p: string) => p),
}));

vi.mock("./uuid.ts", () => ({
  generateUUID: vi.fn(() => "test-uuid"),
}));

import type { ChatHost } from "./app-chat.ts";
import { handleAbortChat, handleSendChat, isChatStopCommand } from "./app-chat.ts";

function createHost(overrides?: Partial<ChatHost>): ChatHost {
  return {
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    sessionKey: "main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    refreshSessionsAfterChat: new Set<string>(),
    ...overrides,
  };
}

describe("handleAbortChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves chatMessage when aborting a running session", async () => {
    const host = createHost({
      chatMessage: "my draft message",
      chatRunId: "run-1",
    });

    await handleAbortChat(host);

    expect(host.chatMessage).toBe("my draft message");
  });

  it("does not clear an empty chatMessage", async () => {
    const host = createHost({ chatMessage: "" });

    await handleAbortChat(host);

    expect(host.chatMessage).toBe("");
  });

  it("does nothing when not connected", async () => {
    const host = createHost({
      connected: false,
      chatMessage: "some text",
    });

    await handleAbortChat(host);

    expect(host.chatMessage).toBe("some text");
  });
});

describe("handleSendChat stop-command path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the stop command from chatMessage when typed in the input", async () => {
    const host = createHost({
      chatMessage: "stop",
      chatRunId: "run-1",
    });

    await handleSendChat(host);

    expect(host.chatMessage).toBe("");
  });

  it("preserves chatMessage when stop command is sent via messageOverride", async () => {
    const host = createHost({
      chatMessage: "my draft",
      chatRunId: "run-1",
    });

    await handleSendChat(host, "stop");

    expect(host.chatMessage).toBe("my draft");
  });
});

describe("isChatStopCommand", () => {
  it("recognizes stop commands", () => {
    expect(isChatStopCommand("stop")).toBe(true);
    expect(isChatStopCommand("/stop")).toBe(true);
    expect(isChatStopCommand("abort")).toBe(true);
    expect(isChatStopCommand("esc")).toBe(true);
  });

  it("rejects non-stop text", () => {
    expect(isChatStopCommand("hello")).toBe(false);
    expect(isChatStopCommand("")).toBe(false);
  });
});
