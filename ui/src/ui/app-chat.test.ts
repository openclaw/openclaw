import { describe, expect, it, vi } from "vitest";
import { handleAbortChat, type ChatHost } from "./app-chat.ts";

const requestMock = vi.fn().mockResolvedValue({});

function createHost(overrides: Partial<ChatHost> = {}): ChatHost {
  return {
    connected: true,
    client: { request: requestMock },
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: "run-1",
    chatSending: false,
    sessionKey: "main",
    basePath: "/",
    hello: null,
    chatAvatarUrl: null,
    refreshSessionsAfterChat: new Set(),
    ...overrides,
  };
}

describe("handleAbortChat", () => {
  it("preserves chat draft text while aborting", async () => {
    requestMock.mockClear();

    const host = createHost({ chatMessage: "typed text" });
    await handleAbortChat(host);

    expect(requestMock).toHaveBeenCalledOnce();
    expect(requestMock).toHaveBeenCalledWith("chat.abort", {
      sessionKey: host.sessionKey,
      runId: host.chatRunId,
    });
    expect(host.chatMessage).toBe("typed text");
  });

  it("does not abort when disconnected", async () => {
    requestMock.mockClear();

    const host = createHost({ connected: false });
    await handleAbortChat(host);

    expect(requestMock).not.toHaveBeenCalled();
    expect(host.chatMessage).toBe("");
  });
});
