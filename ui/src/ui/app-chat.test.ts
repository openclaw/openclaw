import { beforeEach, describe, expect, it, vi } from "vitest";

const abortChatRunMock = vi.fn(async () => true);
const loadChatHistoryMock = vi.fn(async () => undefined);
const sendChatMessageMock = vi.fn(async () => "run-1");
const loadSessionsMock = vi.fn(async () => undefined);
const resetToolStreamMock = vi.fn();

vi.mock("./controllers/chat.ts", () => ({
  abortChatRun: abortChatRunMock,
  loadChatHistory: loadChatHistoryMock,
  sendChatMessage: sendChatMessageMock,
}));

vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: loadSessionsMock,
}));

vi.mock("./app-tool-stream.ts", () => ({
  resetToolStream: resetToolStreamMock,
}));

function createHost() {
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    client: {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        return { ok: true };
      }),
    },
    connected: true,
    chatMessage: "draft",
    chatAttachments: [
      { id: "att-1", dataUrl: "data:image/png;base64,AA==", mimeType: "image/png" },
    ],
    chatQueue: [{ id: "q-1", text: "queued", createdAt: Date.now() }],
    chatRunId: "run-active",
    chatSending: true,
    chatMessages: [{ role: "assistant", content: [{ type: "text", text: "stale" }] }],
    chatSummary: "summary",
    chatContextInfo: { shouldWarn: true },
    chatToolMessages: [{ id: "tool-1" }],
    chatStream: "streaming",
    chatStreamStartedAt: Date.now(),
    compactionStatus: { active: true },
    sessionKey: "agent:main:main",
    basePath: "",
    hello: { snapshot: { sessionDefaults: { mainKey: "main", defaultAgentId: "main" } } },
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "agent:main:main",
      lastActiveSessionKey: "agent:main:main",
      theme: "system",
      chatFocusMode: false,
      chatShowThinking: true,
      chatHistoryMode: "summary",
      splitRatio: 0.6,
      navCollapsed: false,
      navGroupsCollapsed: {},
    },
    applySettings: vi.fn(),
    chatAvatarUrl: "avatar.png",
    chatHistoryMode: "summary",
    refreshSessionsAfterChat: new Set(["run-active"]),
    requests,
  };
}

describe("app chat runtime reset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("agent switch clears runtime state and busy state", async () => {
    const { handleSelectChatAgent, isChatBusy } = await import("./app-chat.ts");
    const host = createHost();

    await handleSelectChatAgent(host as never, "legal");

    expect(abortChatRunMock).toHaveBeenCalledTimes(1);
    expect(host.chatRunId).toBeNull();
    expect(host.chatSending).toBe(false);
    expect(host.chatQueue).toEqual([]);
    expect(host.chatStream).toBeNull();
    expect(host.chatMessages).toEqual([]);
    expect(isChatBusy(host as never)).toBe(false);
    expect(host.sessionKey).toBe("agent:legal:main");
  });

  it("archive clears runId queue and stream before switching", async () => {
    const { archiveActiveChat } = await import("./app-chat.ts");
    const host = createHost();

    await archiveActiveChat(host as never);

    expect(abortChatRunMock).toHaveBeenCalledTimes(1);
    expect(host.requests[0]).toEqual({
      method: "sessions.archive",
      params: { key: "agent:main:main" },
    });
    expect(host.chatRunId).toBeNull();
    expect(host.chatQueue).toEqual([]);
    expect(host.chatStream).toBeNull();
    expect(host.chatSending).toBe(false);
    expect(host.sessionKey).toMatch(/^agent:main:chat:/);
  });

  it("new chat clears runId queue and stream", async () => {
    const { startNewChat } = await import("./app-chat.ts");
    const host = createHost();

    await startNewChat(host as never);

    expect(abortChatRunMock).toHaveBeenCalledTimes(1);
    expect(host.chatRunId).toBeNull();
    expect(host.chatQueue).toEqual([]);
    expect(host.chatStream).toBeNull();
    expect(host.chatSending).toBe(false);
    expect(host.sessionKey).toMatch(/^agent:main:chat:/);
  });
});
