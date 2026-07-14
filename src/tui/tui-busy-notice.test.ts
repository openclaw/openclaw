import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { ChatLog } from "./components/chat-log.js";
import { addBlockedChatSubmitNotice, TUI_AGENT_BUSY_MESSAGE } from "./tui-busy-notice.js";

describe("addBlockedChatSubmitNotice", () => {
  it("coalesces repeated busy submit notices", () => {
    const chatLog = new ChatLog(20);

    addBlockedChatSubmitNotice(chatLog);
    addBlockedChatSubmitNotice(chatLog);
    addBlockedChatSubmitNotice(chatLog);

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(1);
    expect(rendered).toContain(`${TUI_AGENT_BUSY_MESSAGE} x3`);
  });
});
