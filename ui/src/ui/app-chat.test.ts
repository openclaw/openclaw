import { describe, expect, it } from "vitest";
import { handleSendChat, type ChatHost } from "./app-chat.ts";

function createHost(overrides: Partial<ChatHost> = {}): ChatHost {
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
    refreshSessionsAfterChat: new Set(),
    ...overrides,
  };
}

describe("chat addendum queue", () => {
  it("queues 'btw' messages as addendums (front of queue) when busy", async () => {
    const host = createHost({
      chatRunId: "run-1",
      chatMessage: "btw: also, it is in vlan 66",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.kind).toBe("addendum");
    expect(host.chatQueue[0]?.text).toBe("also, it is in vlan 66");
    expect(host.chatMessage).toBe("");
    expect(host.chatAttachments).toEqual([]);
  });

  it("inserts addendums ahead of already-queued normal messages", async () => {
    const host = createHost({
      chatRunId: "run-1",
      chatQueue: [
        {
          id: "q-1",
          kind: "message",
          text: "next question",
          createdAt: 1,
        },
      ],
      chatMessage: "btw - one more detail",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(2);
    expect(host.chatQueue[0]?.kind).toBe("addendum");
    expect(host.chatQueue[0]?.text).toBe("one more detail");
    expect(host.chatQueue[1]?.text).toBe("next question");
  });

  it("merges consecutive addendums into a single queued addendum", async () => {
    const host = createHost({
      chatRunId: "run-1",
      chatQueue: [
        {
          id: "a-1",
          kind: "addendum",
          text: "first addendum",
          createdAt: 1,
        },
      ],
      chatMessage: "btw second addendum",
    });

    await handleSendChat(host);

    expect(host.chatQueue).toHaveLength(1);
    expect(host.chatQueue[0]?.kind).toBe("addendum");
    expect(host.chatQueue[0]?.text).toBe("first addendum\n\nsecond addendum");
  });
});
