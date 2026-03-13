import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatHost } from "./app-chat.ts";
import type { ChatAttachment } from "./ui-types.ts";

vi.mock("./app-scroll.ts", () => ({
  scheduleChatScroll: vi.fn(),
  resetToolStream: vi.fn(),
}));

vi.mock("./app-settings.ts", () => ({
  setLastActiveSessionKey: vi.fn(),
}));

vi.mock("./app-tool-stream.ts", () => ({
  resetToolStream: vi.fn(),
}));

vi.mock("./controllers/chat.ts", () => ({
  abortChatRun: vi.fn(),
  loadChatHistory: vi.fn(),
  sendChatMessage: vi.fn().mockResolvedValue("run-1"),
}));

vi.mock("./controllers/sessions.ts", () => ({
  loadSessions: vi.fn(),
}));

const { handleSendChat } = await import("./app-chat.ts");
const { sendChatMessage } = await import("./controllers/chat.ts");

function makeAttachment(id = "att-1"): ChatAttachment {
  return {
    id,
    dataUrl: "data:image/png;base64,AAA=",
    mimeType: "image/png",
  };
}

function makeHost(overrides?: Partial<ChatHost>): ChatHost {
  return {
    client: null,
    chatMessages: [],
    chatStream: null,
    connected: true,
    chatMessage: "",
    chatAttachments: [],
    chatAttachmentReadsPending: 0,
    chatBufferedAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    lastError: null,
    sessionKey: "agent:main",
    basePath: "",
    hello: null,
    chatAvatarUrl: null,
    refreshSessionsAfterChat: new Set<string>(),
    ...overrides,
  };
}

describe("handleSendChat", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("falls back to buffered attachments when the live attachment state is empty", async () => {
    const attachment = makeAttachment();
    const host = makeHost({
      chatMessage: "describe image",
      chatAttachments: [],
      chatBufferedAttachments: [attachment],
    });

    await handleSendChat(host);

    expect(sendChatMessage).toHaveBeenCalledWith(host, "describe image", [attachment]);
  });

  it("waits for pending attachment reads before sending", async () => {
    vi.useFakeTimers();
    const attachment = makeAttachment();
    const host = makeHost({
      chatMessage: "describe image",
      chatAttachmentReadsPending: 1,
    });

    const sendPromise = handleSendChat(host);

    host.chatBufferedAttachments = [attachment];
    host.chatAttachmentReadsPending = 0;

    await vi.runAllTimersAsync();
    await sendPromise;

    expect(sendChatMessage).toHaveBeenCalledWith(host, "describe image", [attachment]);
  });
});
