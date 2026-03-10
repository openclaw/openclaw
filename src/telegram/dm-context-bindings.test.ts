import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  __testing,
  buildTelegramForumConversationId,
  clearTelegramDmContextBinding,
  getTelegramDmContextBinding,
  parseTelegramChatId,
  parseTelegramTopicId,
  setTelegramDmContextBinding,
  validateTargetChatId,
} from "./dm-context-bindings.js";

describe("telegram dm context bindings", () => {
  it("parses and validates chat/topic ids", () => {
    expect(parseTelegramChatId("-1001")).toBe("-1001");
    expect(parseTelegramChatId("abc")).toBeUndefined();
    expect(validateTargetChatId("-1001")).toBe("-1001");
    expect(validateTargetChatId("1001")).toBeUndefined();

    expect(parseTelegramTopicId("1")).toBe(1);
    expect(parseTelegramTopicId("0")).toBeUndefined();
    expect(parseTelegramTopicId("-1")).toBeUndefined();
  });

  it("sets/gets/clears binding", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oc-telegram-dmctx-"));
    process.env.OPENCLAW_STATE_DIR = tmp;
    const accountId = "default";
    const dmChatId = "123";

    expect(getTelegramDmContextBinding({ accountId, dmChatId })).toBeUndefined();

    const binding = await setTelegramDmContextBinding({
      accountId,
      dmChatId,
      chatId: "-100987",
      topicId: 42,
    });

    expect(binding.conversationId).toBe(buildTelegramForumConversationId("-100987", 42));
    expect(getTelegramDmContextBinding({ accountId, dmChatId })?.topicId).toBe(42);

    const storePath = __testing.resolveStorePath(tmp);
    expect(fs.existsSync(storePath)).toBe(true);

    const cleared = await clearTelegramDmContextBinding({ accountId, dmChatId });
    expect(cleared).toBe(true);
    expect(getTelegramDmContextBinding({ accountId, dmChatId })).toBeUndefined();
  });
});
