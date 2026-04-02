import { describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.js";

describe("ChatLog", () => {
  it("caps component growth to avoid unbounded render trees", () => {
    const chatLog = new ChatLog(20);
    for (let i = 1; i <= 40; i++) {
      chatLog.addSystem(`system-${i}`);
    }

    expect(chatLog.children.length).toBe(20);
    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("system-40");
    expect(rendered).not.toContain("system-1");
  });

  it("drops stale streaming references when old components are pruned", () => {
    const chatLog = new ChatLog(20);
    chatLog.startAssistant("first", "run-1");
    for (let i = 0; i < 25; i++) {
      chatLog.addSystem(`overflow-${i}`);
    }

    // Should not throw if the original streaming component was pruned.
    chatLog.updateAssistant("recreated", "run-1");

    const rendered = chatLog.render(120).join("\n");
    expect(chatLog.children.length).toBe(20);
    expect(rendered).toContain("recreated");
  });

  it("does not append duplicate assistant components when a run is started twice", () => {
    const chatLog = new ChatLog(40);
    chatLog.startAssistant("first", "run-dup");
    chatLog.startAssistant("second", "run-dup");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("second");
    expect(rendered).not.toContain("first");
    expect(chatLog.children.length).toBe(1);
  });

  it("preserves intermediate assistant stream updates when enabled", () => {
    const chatLog = new ChatLog(40, { preserveIntermediate: true });

    chatLog.updateAssistant("first", "run-preserve");
    chatLog.updateAssistant("second", "run-preserve");
    chatLog.finalizeAssistant("final", "run-preserve");

    const entries = chatLog.render(120).join("\n");
    expect(entries).toContain("first");
    expect(entries).toContain("second");
    expect(entries).toContain("final");
    expect(chatLog.children.length).toBe(3);
  });

  it("drops stale tool references when old components are pruned", () => {
    const chatLog = new ChatLog(20);
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    for (let i = 0; i < 25; i++) {
      chatLog.addSystem(`overflow-${i}`);
    }

    // Should no-op safely after the tool component is pruned.
    chatLog.updateToolResult("tool-1", { content: [{ type: "text", text: "done" }] });

    expect(chatLog.children.length).toBe(20);
  });

  it("prunes system messages atomically when a non-system entry overflows the log", () => {
    const chatLog = new ChatLog(20);
    for (let i = 1; i <= 20; i++) {
      chatLog.addSystem(`system-${i}`);
    }

    chatLog.addUser("hello");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).not.toMatch(/\bsystem-1\b/);
    expect(rendered).toMatch(/\bsystem-2\b/);
    expect(rendered).toMatch(/\bsystem-20\b/);
    expect(rendered).toContain("hello");
    expect(chatLog.children.length).toBe(20);
  });

  it("renders BTW inline and removes it when dismissed", () => {
    const chatLog = new ChatLog(40);

    chatLog.addSystem("session agent:main:main");
    chatLog.showBtw({
      question: "what is 17 * 19?",
      text: "323",
    });

    let rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("BTW: what is 17 * 19?");
    expect(rendered).toContain("323");
    expect(chatLog.hasVisibleBtw()).toBe(true);

    chatLog.dismissBtw();

    rendered = chatLog.render(120).join("\n");
    expect(rendered).not.toContain("BTW: what is 17 * 19?");
    expect(chatLog.hasVisibleBtw()).toBe(false);
  });
});
