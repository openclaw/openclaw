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

const { readEmbeddedHistoryMessages } = await import("./embedded-history-messages.js");

const params: ChatHistoryPageParams = {
  entry: undefined,
  provider: "openai",
  sessionId: "sess-main",
  storePath: "/tmp/openclaw-sessions.json",
  sessionAgentId: "main",
  canonicalKey: "agent:main:main",
  max: 200,
  maxHistoryBytes: 6 * 1024 * 1024,
  effectiveMaxChars: 8_000,
  offset: undefined,
  messageId: undefined,
};

const preview = "p".repeat(8_000);
const capped = {
  role: "assistant",
  content: [{ type: "text", text: `${preview}\n...(truncated)...` }],
  __openclaw: { id: "long-reply", truncated: true, reason: "display-cap" },
};
const stored = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  __openclaw: { id: "long-reply" },
});
const marked = (note: string) => ({
  ...capped,
  content: [{ type: "text", text: `${preview}\n...(truncated; ${note})...` }],
});

describe("readEmbeddedHistoryMessages", () => {
  beforeEach(() => {
    readChatHistoryPageMock.mockReset();
    readChatHistoryMessageByIdMock.mockReset();
  });

  it("shows uncapped history as read", async () => {
    const reply = stored("short reply");
    readChatHistoryPageMock.mockResolvedValueOnce({ messages: [reply], activity: [] });

    await expect(readEmbeddedHistoryMessages(params)).resolves.toEqual({
      messages: [reply],
      activity: [],
    });
    expect(readChatHistoryMessageByIdMock).not.toHaveBeenCalled();
  });

  it("shows the stored reply in place of a display-capped preview", async () => {
    const full = stored(`${preview} the rest\n\nTHE END`);
    readChatHistoryPageMock.mockResolvedValueOnce({ messages: [capped], activity: [] });
    readChatHistoryMessageByIdMock.mockResolvedValueOnce({ found: true, message: full });

    await expect(readEmbeddedHistoryMessages(params)).resolves.toEqual({
      messages: [full],
      activity: [],
    });
    expect(readChatHistoryMessageByIdMock).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "long-reply", effectiveMaxChars: 1_000_000 }),
    );
  });

  it("loads full text after the page budget, so older rows stay", async () => {
    const older = { role: "user", content: [{ type: "text", text: "u".repeat(15_000) }] };
    const full = stored("r".repeat(30_000));
    readChatHistoryPageMock.mockResolvedValueOnce({ messages: [older, capped], activity: [] });
    readChatHistoryMessageByIdMock.mockResolvedValueOnce({ found: true, message: full });

    const result = await readEmbeddedHistoryMessages({ ...params, maxHistoryBytes: 40_000 });

    expect(result.messages).toEqual([older, full]);
  });

  it("shows a reply over the 128 KiB row limit in full, as chat.message.get does", async () => {
    const full = stored(`${"x".repeat(150_000)}\n\nTHE END`);
    readChatHistoryPageMock.mockResolvedValueOnce({ messages: [capped], activity: [] });
    readChatHistoryMessageByIdMock.mockResolvedValueOnce({ found: true, message: full });

    await expect(readEmbeddedHistoryMessages(params)).resolves.toEqual({
      messages: [full],
      activity: [],
    });
  });

  it.each([
    {
      name: "a reply the reader reports oversized",
      read: { found: true, oversized: true },
      note: "the full reply is too large to show here",
    },
    {
      name: "a missing reply",
      read: { found: false },
      note: "couldn't load the full reply. Reopen the session to try again",
    },
  ])("keeps the marked preview for $name", async ({ read, note }) => {
    readChatHistoryPageMock.mockResolvedValueOnce({ messages: [capped], activity: [] });
    readChatHistoryMessageByIdMock.mockResolvedValueOnce(read);

    await expect(readEmbeddedHistoryMessages(params)).resolves.toEqual({
      messages: [marked(note)],
      activity: [],
    });
  });
});
