import { beforeEach, describe, expect, it, vi } from "vitest";

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  },
  configurable: true,
});

const loadChatHistoryMock = vi.fn(async () => undefined);
const loadSessionsMock = vi.fn(async () => undefined);
const scheduleChatScrollMock = vi.fn();

vi.mock("../ui/src/ui/controllers/chat.ts", () => ({
  abortChatRun: vi.fn(),
  loadChatHistory: (...args: unknown[]) => loadChatHistoryMock(...args),
  sendChatMessage: vi.fn(),
}));

vi.mock("../ui/src/ui/controllers/sessions.ts", () => ({
  loadSessions: (...args: unknown[]) => loadSessionsMock(...args),
}));

vi.mock("../ui/src/ui/app-scroll.ts", () => ({
  scheduleChatScroll: (...args: unknown[]) => scheduleChatScrollMock(...args),
}));

const { refreshChat } = await import("../ui/src/ui/app-chat.ts");

describe("refreshChat", () => {
  beforeEach(() => {
    loadChatHistoryMock.mockClear();
    loadSessionsMock.mockClear();
    scheduleChatScrollMock.mockClear();
  });

  it("reloads the chat session list without activeMinutes filtering", async () => {
    const host = {
      connected: false,
      chatMessage: "",
      chatAttachments: [],
      chatQueue: [],
      chatRunId: null,
      chatSending: false,
      sessionKey: "agent:main:main",
      basePath: "",
      hello: null,
      chatAvatarUrl: "stale-avatar",
      refreshSessionsAfterChat: new Set<string>(),
    };

    await refreshChat(host, { scheduleScroll: false });

    expect(loadChatHistoryMock).toHaveBeenCalledWith(host);
    expect(loadSessionsMock).toHaveBeenCalledWith(host);
    expect(scheduleChatScrollMock).not.toHaveBeenCalled();
    expect(host.chatAvatarUrl).toBeNull();
  });
});
