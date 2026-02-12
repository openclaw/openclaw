import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ChatLog } from "./chat-log.js";
import { UserMessageComponent } from "./user-message.js";

/**
 * Verify that no rendered line exceeds the given width.
 * This is the same invariant that pi-tui's doRender() enforces.
 */
function assertNoLineExceedsWidth(lines: string[], width: number, label: string) {
  for (let i = 0; i < lines.length; i++) {
    const w = visibleWidth(lines[i]);
    if (w > width) {
      throw new Error(
        `${label}: line ${i} exceeds terminal width (${w} > ${width})\n` +
          `  content: ${JSON.stringify(lines[i].substring(0, 100))}...`,
      );
    }
  }
}

describe("TUI components: rendered line width safety", () => {
  const terminalWidths = [20, 80, 120, 323, 400];

  for (const width of terminalWidths) {
    describe(`at terminal width ${width}`, () => {
      it("UserMessageComponent handles long text", () => {
        const text = "x ".repeat(300);
        const component = new UserMessageComponent(text);
        const lines = component.render(width);
        assertNoLineExceedsWidth(lines, width, "UserMessage");
        expect(lines.length).toBeGreaterThan(0);
      });

      it("AssistantMessageComponent handles long text", () => {
        const text = "y ".repeat(300);
        const component = new AssistantMessageComponent(text);
        const lines = component.render(width);
        assertNoLineExceedsWidth(lines, width, "AssistantMessage");
        expect(lines.length).toBeGreaterThan(0);
      });

      it("ChatLog handles long system messages", () => {
        const chatLog = new ChatLog();
        chatLog.addSystem("z".repeat(600));
        const lines = chatLog.render(width);
        assertNoLineExceedsWidth(lines, width, "ChatLog/system");
      });

      it("ChatLog handles long user messages", () => {
        const chatLog = new ChatLog();
        chatLog.addUser("w ".repeat(300));
        const lines = chatLog.render(width);
        assertNoLineExceedsWidth(lines, width, "ChatLog/user");
      });

      it("ChatLog handles long assistant messages", () => {
        const chatLog = new ChatLog();
        chatLog.startAssistant("v ".repeat(300));
        const lines = chatLog.render(width);
        assertNoLineExceedsWidth(lines, width, "ChatLog/assistant");
      });

      it("handles text with no spaces (single long word)", () => {
        const text = "x".repeat(600);
        const component = new UserMessageComponent(text);
        const lines = component.render(width);
        assertNoLineExceedsWidth(lines, width, "UserMessage/noSpaces");
      });

      it("handles markdown with code blocks containing long lines", () => {
        const code = "```\n" + "z".repeat(600) + "\n```";
        const component = new AssistantMessageComponent(code);
        const lines = component.render(width);
        assertNoLineExceedsWidth(lines, width, "AssistantMessage/codeBlock");
      });

      it("handles markdown with long URLs", () => {
        const url = "https://example.com/" + "a".repeat(550);
        const md = `[link](${url})`;
        const component = new AssistantMessageComponent(md);
        const lines = component.render(width);
        assertNoLineExceedsWidth(lines, width, "AssistantMessage/longUrl");
      });

      it("handles markdown with long blockquotes", () => {
        const quote = "> " + "q".repeat(600);
        const component = new AssistantMessageComponent(quote);
        const lines = component.render(width);
        assertNoLineExceedsWidth(lines, width, "AssistantMessage/blockquote");
      });
    });
  }

  it("reproduces the exact scenario from issue #14591", () => {
    // Simulate a ~570 character Discord media instruction text
    const discordInstruction =
      "When a user sends an image attachment in Discord, the system intercepts the message, " +
      "downloads the image, and injects it into the prompt as inline content. This allows the AI " +
      "to see and understand the image content. The injected instruction text is approximately five " +
      "hundred and seventy characters long and contains details about how to process the visual " +
      "content including format specifications, dimension constraints, and analysis guidelines " +
      "that the model should follow when responding to the user about the image they shared in " +
      "the Discord channel conversation thread.";

    // Terminal width from the bug report
    const width = 323;

    // Test as user message (how it appears in history)
    const chatLog = new ChatLog();
    chatLog.addUser(discordInstruction);
    const lines = chatLog.render(width);

    for (let i = 0; i < lines.length; i++) {
      const w = visibleWidth(lines[i]);
      expect(w).toBeLessThanOrEqual(width);
    }
  });
});
