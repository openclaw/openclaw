import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

import { runExec } from "../process/exec.js";
import { clearPluginInteractiveHandlers, dispatchPluginInteractiveHandler } from "./interactive.js";

const mockedRunExec = vi.mocked(runExec);

describe("built-in interactive handler dispatch", () => {
  beforeEach(() => {
    clearPluginInteractiveHandlers();
    vi.clearAllMocks();
  });

  it("routes mb callbacks without plugin registration and dedupes by callback id", async () => {
    mockedRunExec
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "[]", stderr: "" });

    const params = {
      channel: "telegram" as const,
      data: "mb:next:19d05a032de0fce7",
      callbackId: "cb-mail-1",
      ctx: {
        accountId: "default",
        callbackId: "cb-mail-1",
        conversationId: "conv-1",
        parentConversationId: "parent-1",
        senderId: "user-1",
        senderUsername: "ada",
        threadId: 77,
        isGroup: true,
        isForum: true,
        auth: { isAuthorizedSender: true },
        callbackMessage: {
          messageId: 55,
          chatId: "-10099",
          messageText: "Mail actions",
        },
      },
      respond: {
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        editButtons: vi.fn(async () => {}),
        clearButtons: vi.fn(async () => {}),
        deleteMessage: vi.fn(async () => {}),
      },
    };

    const first = await dispatchPluginInteractiveHandler(params);
    const duplicate = await dispatchPluginInteractiveHandler(params);

    expect(first).toEqual({ matched: true, handled: true, duplicate: false });
    expect(duplicate).toEqual({ matched: true, handled: true, duplicate: true });
    expect(mockedRunExec).toHaveBeenCalledTimes(2);
  });
});
