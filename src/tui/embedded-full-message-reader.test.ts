import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatHistoryPageParams } from "../config/sessions/session-history-types.js";

const readChatHistoryPageMock = vi.fn();
const readChatHistoryMessageByIdMock = vi.fn();

// mock-isolation: Read synthetic transcript rows without opening Gateway worker databases.
vi.mock("../gateway/server-methods/chat-history-pages.js", () => ({
  readChatHistoryMessageById: (params: unknown) => readChatHistoryMessageByIdMock(params),
  readChatHistoryPage: (params: unknown) => readChatHistoryPageMock(params),
}));

// mock-isolation: Keep fixture rows exact; display projection has its own suites.
vi.mock("../gateway/chat-display-projection.js", () => ({
  augmentChatHistoryWithCanvasBlocks: (messages: unknown[]) => messages,
  projectChatDisplayMessage: (message: unknown) => message,
}));

const { readEmbeddedChatHistoryPage } = await import("./embedded-full-message-reader.js");

const params: ChatHistoryPageParams = {
  entry: undefined,
  provider: "openai",
  sessionId: "sess-main",
  storePath: "/tmp/openclaw-sessions.json",
  sessionAgentId: "main",
  canonicalKey: "agent:main:main",
  max: 200,
  maxHistoryBytes: 100_000,
  effectiveMaxChars: 8_000,
  offset: undefined,
  messageId: undefined,
};

const capped = {
  role: "assistant",
  content: [{ type: "text", text: "preview\n...(truncated)..." }],
  __openclaw: { id: "long-reply", truncated: true, reason: "display-cap" },
};
const full = {
  role: "assistant",
  content: [{ type: "text", text: "stored reply\n\nTHE END" }],
  __openclaw: { id: "long-reply" },
};

describe("readEmbeddedChatHistoryPage", () => {
  beforeEach(() => {
    readChatHistoryPageMock.mockReset();
    readChatHistoryMessageByIdMock.mockReset();
  });

  it("returns the page untouched when no reply is display-capped", async () => {
    const page = { messages: [full] };
    readChatHistoryPageMock.mockResolvedValueOnce(page);

    await expect(readEmbeddedChatHistoryPage(params)).resolves.toBe(page);
    expect(readChatHistoryPageMock).toHaveBeenCalledWith(params);
    expect(readChatHistoryMessageByIdMock).not.toHaveBeenCalled();
  });

  it("replaces a display-capped reply with the stored message", async () => {
    readChatHistoryPageMock.mockResolvedValueOnce({ messages: [capped], hasMore: false });
    readChatHistoryMessageByIdMock.mockResolvedValueOnce({
      found: true,
      oversized: false,
      message: full,
    });

    await expect(readEmbeddedChatHistoryPage(params)).resolves.toEqual({
      messages: [full],
      hasMore: false,
    });
    expect(readChatHistoryMessageByIdMock).toHaveBeenCalledWith({
      ...params,
      messageId: "long-reply",
      max: 1,
      maxHistoryBytes: 25 * 1024 * 1024,
      effectiveMaxChars: 1_000_000,
    });
  });

  it.each([
    { found: false, oversized: false },
    { found: true, oversized: true },
  ])("keeps a visibly marked preview when the stored reply is unavailable: %j", async (result) => {
    readChatHistoryPageMock.mockResolvedValueOnce({ messages: [capped] });
    readChatHistoryMessageByIdMock.mockResolvedValueOnce(result);

    await expect(readEmbeddedChatHistoryPage(params)).resolves.toEqual({
      messages: [
        {
          ...capped,
          content: [
            {
              type: "text",
              text: "preview\n...(truncated; the full reply could not be loaded)...",
            },
          ],
        },
      ],
    });
  });
});
