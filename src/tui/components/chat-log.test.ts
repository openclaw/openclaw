import { beforeEach, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ChatLog } from "./chat-log.js";

describe("ChatLog", () => {
  const capacity = 20;
  let chatLog: ChatLog;
  beforeEach(() => {
    chatLog = new ChatLog(capacity);
  });
  const render = () => normalizeTestText(raw());
  const raw = () => chatLog.render(120).join("\n");
  const tool = (id: string, path: string, runId?: string) =>
    chatLog.startTool(id, "read_file", { path }, runId);
  const result = (id: string, text: string, partial = false) =>
    chatLog.updateToolResult(id, { content: [{ type: "text", text }] }, { partial });
  const expectBefore = (text: string, first: string, second: string) =>
    expect(text.indexOf(first)).toBeLessThan(text.indexOf(second));
  const expectText = (text: string, present: string[], absent: string[] = []) => {
    present.forEach((value) => expect(text).toContain(value));
    absent.forEach((value) => expect(text).not.toContain(value));
  };
  const fill = (count = capacity - chatLog.children.length) => {
    for (let i = 0; i < count; i++) {
      chatLog.addSystem(`notice-${i}`);
    }
  };
  const update = (text: string, runId = "run-1") => chatLog.updateAssistant(text, runId);
  const prompt = (text: string, runId: string) =>
    chatLog.addLiveUser(text, { messageId: `${runId}-user`, runId });
  const expectPrompt = (before: string) => {
    const rendered = render();
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered.split("Prompt.")).toHaveLength(2);
    expectBefore(rendered, "Prompt.", before);
    return rendered;
  };
  const splitReply = () => {
    update("First.");
    tool("tool-1", "a.txt");
    update("First.\n\nSecond.");
    tool("tool-2", "b.txt");
  };
  const addTools = (count: number, completed = false) => {
    for (let i = 0; i < count; i++) {
      tool(`tool-${i}`, `file-${i}.txt`, "run-1");
      if (completed && i > 0) {
        result(`tool-${i}`, `Completed ${i}.`);
      }
    }
  };
  it("coalesces consecutive repeatable system messages", () => {
    const rawText = "\x1b[?7777h\x1b]52;c;T08_CHAT_LOG_ONLY_CONTROLS\x07";
    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    const output = raw();
    expect(chatLog.children.length).toBe(1);
    expect(normalizeTestText(output)).toContain("(no output) x3");
    expect(output).not.toContain(rawText);
  });

  it("does not coalesce distinct raw system messages that sanitize identically", () => {
    chatLog.addSystem("\x1b[?7776h", { coalesceConsecutive: true });
    chatLog.addSystem("\u009b777;888H", { coalesceConsecutive: true });
    const rendered = render();
    expect(chatLog.children.length).toBe(2);
    expect(rendered.match(/\(no output\)/g)).toHaveLength(2);
    expect(rendered).not.toContain("x2");
  });

  it("drops stale streaming references when old components are pruned", () => {
    update("first");
    fill(25);
    update("recreated");
    expect(chatLog.children.length).toBe(20);
    expect(raw()).toContain("recreated");
  });

  it("reconciles a revised final snapshot after multiple frozen tool calls", () => {
    splitReply();
    chatLog.finalizeAssistant("Revised first segment.\n\nFinal answer.", "run-1");
    const rendered = render();
    expect(rendered.split("Revised first segment.")).toHaveLength(2);
    expect(rendered.split("Final answer.")).toHaveLength(2);
    expect(rendered).not.toContain("Second.");
    expectText(rendered, ["a.txt", "b.txt"]);
    expect(rendered.lastIndexOf("Read File")).toBeLessThan(rendered.indexOf("Final answer."));
  });

  it("removes frozen provisional text when the final snapshot retracts it", () => {
    update("Retracted provisional answer.");
    tool("tool-1", "a.txt");
    chatLog.finalizeAssistant("", "run-1");
    expectText(render(), ["a.txt"], ["Retracted provisional answer."]);
  });

  it("clears frozen assistant, user and pending references when history is rebuilt", () => {
    update("Before the tool.");
    tool("tool-1", "a.txt");
    chatLog.addLiveUser("Previous.", { messageId: "previous-user" });
    chatLog.addPendingUser("previous-run", "Pending.");
    chatLog.clearAll();
    update("Before the tool.\n\nNew history.");
    chatLog.addUser("Selected.", { messageId: "selected-user" });
    expectText(render(), ["Before the tool.", "New history."]);
    expectText(render(), ["Selected."], ["Previous.", "Pending."]);
    expect(chatLog.countPendingUsers()).toBe(0);
    expect(chatLog.children).toHaveLength(2);
  });

  it("removes every frozen assistant segment when a tool-using run is dropped", () => {
    splitReply();
    update("First.\n\nSecond.\n\nThird.");
    const beforeDrop = render();
    for (const text of ["First.", "Second.", "Third."]) {
      expect(beforeDrop.split(text)).toHaveLength(2);
    }
    expectBefore(beforeDrop, "First.", "a.txt");
    expectBefore(beforeDrop, "a.txt", "Second.");
    expectBefore(beforeDrop, "Second.", "b.txt");
    expectBefore(beforeDrop, "b.txt", "Third.");
    chatLog.dropAssistant("run-1");
    expectText(render(), ["a.txt", "b.txt"], ["First.", "Second.", "Third."]);
    update("Fresh run.");
    expect(render()).toContain("Fresh run.");
  });

  it("reserves assistant position without clearing existing streamed text", () => {
    chatLog.updateAssistant("partial", "run-active");
    chatLog.reserveAssistantSlot("run-active");
    expect(raw()).toContain("partial");
    expect(chatLog.children.length).toBe(1);
  });

  it("renders BTW inline and removes it when dismissed", () => {
    chatLog.addSystem("session agent:main:main");
    chatLog.showBtw({ question: "what is 17 * 19?", text: "323" });
    expectText(raw(), ["BTW: what is 17 * 19?", "323"]);
    expect(chatLog.hasVisibleBtw()).toBe(true);
    chatLog.dismissBtw();
    expect(raw()).not.toContain("BTW: what is 17 * 19?");
    expect(chatLog.hasVisibleBtw()).toBe(false);
  });

  it("updates a pending viewport component in place for the same run", () => {
    chatLog.addPendingUser("run-1", "Original pending prompt.");
    chatLog.addPendingUser("run-1", "Updated pending prompt.");
    expect(chatLog.children).toHaveLength(1);
    expect(chatLog.countPendingUsers()).toBe(1);
    expectText(render(), ["Updated pending prompt."], ["Original pending prompt."]);
  });

  it("keeps scrollback bounded when every visible tool belongs to the delayed prompt's run", () => {
    update("Reply.");
    addTools(19);
    prompt("Prompt.", "run-1");
    const rendered = expectPrompt("Reply.");
    expectText(rendered, ["file-18.txt"], ["file-0.txt"]);
    result("tool-0", "evicted tool must stay detached");
    expect(chatLog.children).toHaveLength(20);
    expect(raw()).not.toContain("evicted tool must stay detached");
  });

  it.each([false, true])(
    "orders a finalized reply's delayed prompt (retracted=%s)",
    (retracted) => {
      update("First.");
      tool("tool-1", "shared.txt");
      update("First.\n\nLast.");
      chatLog.finalizeAssistant(retracted ? "First." : "First.\n\nLast.", "run-1");
      fill();
      prompt("Prompt.", "run-1");
      prompt("Prompt.", "run-1");
      expect(expectPrompt("First.").includes("Last.")).toBe(!retracted);
    },
  );

  it("orders a delayed prompt before owned tools after all assistants are evicted", () => {
    splitReply();
    chatLog.finalizeAssistant("First.\n\nSecond.", "run-1");
    fill();
    fill(3);
    prompt("Prompt.", "run-1");
    prompt("Prompt.", "run-1");
    expect(expectPrompt("b.txt")).not.toContain("Second.");
  });

  it("retains an executing tool while reserving a delayed prompt at capacity 20", () => {
    const runId = `active-tool-${capacity}`;
    let assistantText = "";
    for (let index = 0; index < capacity - 1; index += 1) {
      assistantText += `${index === 0 ? "" : "\n\n"}Running reply segment ${index}.`;
      chatLog.updateAssistant(assistantText, runId);
      tool(`${runId}-previous-tool-${index}`, `previous-${index}.txt`, runId);
      chatLog.clearTools();
    }
    const activeToolId = `${runId}-active-tool`;
    tool(activeToolId, "still-running.txt", runId);
    prompt("Delayed prompt during active tool.", runId);
    result(activeToolId, "Visible partial tool output.", true);
    let rendered = render();
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered).toContain("Visible partial tool output.");
    expectBefore(rendered, "Delayed prompt during active tool.", "Running reply segment 0.");
    result(activeToolId, "Visible final tool output.");
    rendered = render();
    expect(rendered).toContain("Visible final tool output.");
    expect(chatLog.children).toHaveLength(capacity);
  });

  it("preserves both a streaming reply and an executing tool at full capacity 20", () => {
    update("First.");
    addTools(capacity - 2, true);
    update("First.\n\nStreaming.");
    prompt("Prompt.", "run-1");
    result("tool-0", "Progress.", true);
    update("First.\n\nUpdated.");
    const rendered = expectPrompt("First.");
    expectText(rendered, ["Progress.", "Updated."], ["Completed 1."]);
  });

  it("evicts a completed first segment before an executing tool at capacity 20", () => {
    update("Completed.");
    addTools(capacity - 2);
    update("Completed.\n\nLive.");
    prompt("Prompt.", "run-1");
    for (const index of [0, capacity - 3]) {
      result(`tool-${index}`, `Active ${index}.`, true);
    }
    const rendered = render();
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered.match(/Prompt\./g)).toHaveLength(1);
    expectText(rendered, ["Live.", "Active 0.", `Active ${capacity - 3}.`], ["Completed."]);
  });

  it("sanitizes, replaces and idempotently dismisses a pending system notice", () => {
    const firstAttack = "\x1b]52;c;T08_PENDING_FIRST\x07";
    const secondAttack = "\u009d0;T08_PENDING_SECOND\u009c";
    chatLog.addPendingSystem("run-1", `first ${firstAttack}notice`);
    expect(raw()).toContain("first");
    chatLog.addPendingSystem("run-1", secondAttack);
    const output = raw();
    expectText(normalizeTestText(output), ["(no output)"], ["first notice"]);
    expect(output).not.toContain(firstAttack);
    expect(output).not.toContain(secondAttack);
    expect(chatLog.children.length).toBe(1);
    chatLog.dismissPendingSystem("run-1");
    expect(raw()).not.toContain("(no output)");
    chatLog.dismissPendingSystem("run-1");
    expect(raw()).not.toContain("(no output)");
  });
});
