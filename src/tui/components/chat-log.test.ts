import { beforeEach, describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ChatLog } from "./chat-log.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

describe("ChatLog", () => {
  const capacity = 20;
  let chatLog: ChatLog;
  beforeEach(() => {
    chatLog = new ChatLog(40);
  });
  const render = () => normalizeTestText(raw());
  const raw = () => chatLog.render(120).join("\n");
  const roles = () =>
    chatLog.children.map((component) =>
      component instanceof MarkdownMessageComponent ? component.role : component.constructor.name,
    );
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
  it("coalesces consecutive repeatable system messages", () => {
    chatLog = new ChatLog(20);
    const rawText = "\x1b[?7777h\x1b]52;c;T08_CHAT_LOG_ONLY_CONTROLS\x07";
    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    const output = raw();
    const rendered = normalizeTestText(output);
    expect(chatLog.children.length).toBe(1);
    expect(rendered).toContain("(no output) x3");
    expect(output).not.toContain(rawText);
  });

  it("does not coalesce distinct raw system messages that sanitize identically", () => {
    chatLog = new ChatLog(20);
    chatLog.addSystem("\x1b[?7776h", { coalesceConsecutive: true });
    chatLog.addSystem("\u009b777;888H", { coalesceConsecutive: true });
    const rendered = render();
    expect(chatLog.children.length).toBe(2);
    expect(rendered.match(/\(no output\)/g)).toHaveLength(2);
    expect(rendered).not.toContain("x2");
  });

  it("drops stale streaming references when old components are pruned", () => {
    chatLog = new ChatLog(20);
    chatLog.updateAssistant("first", "run-1");
    for (let i = 0; i < 25; i++) {
      chatLog.addSystem(`overflow-${i}`);
    }
    chatLog.updateAssistant("recreated", "run-1");
    const rendered = raw();
    expect(chatLog.children.length).toBe(20);
    expect(rendered).toContain("recreated");
  });

  it("reconciles a revised final snapshot after multiple frozen tool calls", () => {
    chatLog.updateAssistant("First segment.", "run-1");
    tool("tool-1", "a.txt");
    chatLog.updateAssistant("First segment.\n\nSecond segment.", "run-1");
    tool("tool-2", "b.txt");
    chatLog.finalizeAssistant("Revised first segment.\n\nFinal answer.", "run-1");
    const rendered = render();
    expect(rendered.split("Revised first segment.")).toHaveLength(2);
    expect(rendered.split("Final answer.")).toHaveLength(2);
    expect(rendered).not.toContain("Second segment.");
    expect(roles()).toEqual(["ToolExecutionComponent", "ToolExecutionComponent", "assistant"]);
    expect(rendered.lastIndexOf("Read File")).toBeLessThan(rendered.indexOf("Final answer."));
  });

  it("removes frozen provisional text when the final snapshot retracts it", () => {
    chatLog.updateAssistant("Retracted provisional answer.", "run-1");
    tool("tool-1", "a.txt");
    chatLog.finalizeAssistant("", "run-1");
    expect(render()).not.toContain("Retracted provisional answer.");
    expect(roles()).toEqual(["ToolExecutionComponent"]);
  });

  it("clears frozen assistant segments when the chat history is rebuilt", () => {
    chatLog.updateAssistant("Before the tool.", "run-1");
    tool("tool-1", "a.txt");
    chatLog.clearAll();
    chatLog.updateAssistant("Before the tool.\n\nNew history.", "run-1");
    expectText(render(), ["Before the tool.", "New history."]);
    expect(chatLog.children).toHaveLength(1);
  });

  it("removes every frozen assistant segment when a tool-using run is dropped", () => {
    chatLog.updateAssistant("First segment.", "run-1");
    tool("tool-1", "a.txt");
    chatLog.updateAssistant("First segment.\n\nSecond segment.", "run-1");
    tool("tool-2", "b.txt");
    chatLog.updateAssistant("First segment.\n\nSecond segment.\n\nThird segment.", "run-1");
    const beforeDrop = render();
    for (const text of ["First segment.", "Second segment.", "Third segment."]) {
      expect(beforeDrop.split(text)).toHaveLength(2);
    }
    expectBefore(beforeDrop, "First segment.", "a.txt");
    expectBefore(beforeDrop, "a.txt", "Second segment.");
    expectBefore(beforeDrop, "Second segment.", "b.txt");
    expectBefore(beforeDrop, "b.txt", "Third segment.");
    chatLog.dropAssistant("run-1");
    expect(roles()).toEqual(["ToolExecutionComponent", "ToolExecutionComponent"]);
    const rendered = render();
    expectText(rendered, [], ["First segment.", "Second segment.", "Third segment."]);
    chatLog.updateAssistant("Fresh run.", "run-1");
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
    let rendered = raw();
    expect(rendered).toContain("BTW: what is 17 * 19?");
    expect(rendered).toContain("323");
    expect(chatLog.hasVisibleBtw()).toBe(true);
    chatLog.dismissBtw();
    rendered = raw();
    expect(rendered).not.toContain("BTW: what is 17 * 19?");
    expect(chatLog.hasVisibleBtw()).toBe(false);
  });

  it("clears user and pending component references before the next projected session", () => {
    chatLog.addLiveUser("Previous session prompt.", { messageId: "previous-user" });
    chatLog.addPendingUser("previous-run", "Previous pending prompt.");
    chatLog.clearAll();
    chatLog.addUser("Selected session prompt.", { messageId: "selected-user" });
    const rendered = render();
    expect(rendered).toContain("Selected session prompt.");
    expect(rendered).not.toContain("Previous session prompt.");
    expect(rendered).not.toContain("Previous pending prompt.");
    expect(chatLog.countPendingUsers()).toBe(0);
    expect(chatLog.children).toHaveLength(1);
  });

  it("updates a pending viewport component in place for the same run", () => {
    chatLog.addPendingUser("run-1", "Original pending prompt.");
    chatLog.addPendingUser("run-1", "Updated pending prompt.");
    const rendered = render();
    expect(chatLog.children).toHaveLength(1);
    expect(chatLog.countPendingUsers()).toBe(1);
    expectText(rendered, ["Updated pending prompt."], ["Original pending prompt."]);
  });

  it("keeps scrollback bounded when every visible tool belongs to the delayed prompt's run", () => {
    chatLog = new ChatLog(20);
    chatLog.updateAssistant("Reply with many tools.", "shared-run");
    for (let index = 0; index < 19; index += 1) {
      tool(`shared-tool-${index}`, `shared-${index}.txt`, "shared-run");
    }
    chatLog.addLiveUser("Authoritative prompt before many tools.", {
      messageId: "shared-user",
      runId: "shared-run",
    });
    const rendered = render();
    expect(chatLog.children).toHaveLength(20);
    expect(rendered.match(/Authoritative prompt before many tools\./g)).toHaveLength(1);
    expectBefore(rendered, "Authoritative prompt before many tools.", "Reply with many tools.");
    expect(rendered).not.toContain("shared-0.txt");
    expect(rendered).toContain("shared-18.txt");
    result("shared-tool-0", "evicted tool must stay detached");
    expect(chatLog.children).toHaveLength(20);
    expect(raw()).not.toContain("evicted tool must stay detached");
  });

  it.each(["tool-finished", "tool-finished-retracted-tail"])(
    "orders a delayed prompt before a %s reply at capacity 20",
    (phase) => {
      chatLog = new ChatLog(capacity);
      const runId = `shared-${phase}-${capacity}`;
      chatLog.updateAssistant("First reply segment.", runId);
      tool(`${runId}-tool`, "shared.txt");
      chatLog.updateAssistant("First reply segment.\n\nLast reply segment.", runId);
      chatLog.finalizeAssistant(
        phase === "tool-finished"
          ? "First reply segment.\n\nLast reply segment."
          : "First reply segment.",
        runId,
      );
      while (chatLog.children.length < capacity) {
        chatLog.addSystem(`Old notice ${chatLog.children.length}.`);
      }
      const prompt = { messageId: `${runId}-user`, runId };
      chatLog.addLiveUser("Authoritative shared prompt.", prompt);
      chatLog.addLiveUser("Authoritative shared prompt.", prompt);
      const rendered = render();
      expect(chatLog.children).toHaveLength(capacity);
      expect(rendered.match(/Authoritative shared prompt\./g)).toHaveLength(1);
      expectBefore(rendered, "Authoritative shared prompt.", "First reply segment.");
      if (phase === "tool-finished") {
        expect(rendered).toContain("Last reply segment.");
      } else {
        expect(rendered).not.toContain("Last reply segment.");
      }
    },
  );

  it("orders a delayed prompt before owned tools after all assistants are evicted", () => {
    chatLog = new ChatLog(capacity);
    const runId = "evicted-all-assistants";
    chatLog.updateAssistant("First evicted reply segment.", runId);
    tool(`${runId}-first-tool`, "first-shared.txt", runId);
    chatLog.updateAssistant("First evicted reply segment.\n\nLast evicted reply segment.", runId);
    tool(`${runId}-last-tool`, "last-shared.txt", runId);
    chatLog.finalizeAssistant("First evicted reply segment.\n\nLast evicted reply segment.", runId);
    while (chatLog.children.length < capacity) {
      chatLog.addSystem(`Retained notice ${chatLog.children.length}.`);
    }
    for (let index = 0; index < 3; index += 1) {
      chatLog.addSystem(`Evicting notice ${index}.`);
    }
    const prompt = { messageId: `${runId}-user`, runId };
    chatLog.addLiveUser("Delayed prompt before surviving tools.", prompt);
    chatLog.addLiveUser("Delayed prompt before surviving tools.", prompt);
    const rendered = render();
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered.match(/Delayed prompt before surviving tools\./g)).toHaveLength(1);
    expectBefore(rendered, "Delayed prompt before surviving tools.", "last-shared.txt");
    expect(rendered).not.toContain("Last evicted reply segment.");
  });

  it("retains an executing tool while reserving a delayed prompt at capacity 20", () => {
    chatLog = new ChatLog(capacity);
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
    chatLog.addLiveUser("Delayed prompt during active tool.", {
      messageId: `${runId}-user`,
      runId,
    });
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
    chatLog = new ChatLog(capacity);
    const runId = `live-components-${capacity}`;
    chatLog.updateAssistant("First preserved live reply.", runId);
    const activeToolId = `${runId}-active-tool`;
    for (let index = 0; index < capacity - 2; index += 1) {
      const toolId = index === 0 ? activeToolId : `${runId}-completed-tool-${index}`;
      tool(toolId, `live-tool-${index}.txt`, runId);
      if (index > 0) {
        result(toolId, `Completed historical tool ${index}.`);
      }
    }
    chatLog.updateAssistant(
      "First preserved live reply.\n\nStreaming reply remains visible.",
      runId,
    );
    chatLog.addLiveUser("Delayed prompt during live components.", {
      messageId: `${runId}-user`,
      runId,
    });
    result(activeToolId, "Live tool progress remains visible.", true);
    chatLog.updateAssistant("First preserved live reply.\n\nUpdated streaming reply.", runId);
    const rendered = render();
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered.match(/Delayed prompt during live components\./g)).toHaveLength(1);
    expectBefore(rendered, "Delayed prompt during live components.", "First preserved live reply.");
    expect(rendered).toContain("Live tool progress remains visible.");
    expect(rendered).toContain("Updated streaming reply.");
    expect(rendered).not.toContain("Completed historical tool 1.");
  });

  it("evicts a completed first segment before an executing tool at capacity 20", () => {
    chatLog = new ChatLog(capacity);
    const runId = `only-completed-anchor-${capacity}`;
    chatLog.updateAssistant("Only completed reply segment.", runId);
    for (let index = 0; index < capacity - 2; index += 1) {
      tool(`${runId}-active-tool-${index}`, `active-only-${index}.txt`, runId);
    }
    chatLog.updateAssistant("Only completed reply segment.\n\nProtected live reply.", runId);
    chatLog.addLiveUser("Delayed prompt before concurrent tools.", {
      messageId: `${runId}-user`,
      runId,
    });
    for (const index of [0, capacity - 3]) {
      result(`${runId}-active-tool-${index}`, `Protected active tool ${index}.`, true);
    }
    const rendered = render();
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered.match(/Delayed prompt before concurrent tools\./g)).toHaveLength(1);
    expect(rendered).not.toContain("Only completed reply segment.");
    expect(rendered).toContain("Protected live reply.");
    expect(rendered).toContain("Protected active tool 0.");
    expect(rendered).toContain(`Protected active tool ${capacity - 3}.`);
  });

  it("dismisses a pending system notice by runId", () => {
    chatLog.addPendingSystem("run-1", "taking longer than expected");
    expect(raw()).toContain("taking longer than expected");
    expect(chatLog.dismissPendingSystem("run-1")).toBe(true);
    expect(raw()).not.toContain("taking longer than expected");
    expect(chatLog.dismissPendingSystem("run-1")).toBe(false);
  });

  it("replaces an existing pending system notice for the same runId", () => {
    const firstAttack = "\x1b]52;c;T08_PENDING_FIRST\x07";
    const secondAttack = "\u009d0;T08_PENDING_SECOND\u009c";
    chatLog.addPendingSystem("run-1", `first ${firstAttack}notice`);
    chatLog.addPendingSystem("run-1", secondAttack);
    const output = raw();
    const rendered = normalizeTestText(output);
    expect(rendered).not.toContain("first notice");
    expect(rendered).toContain("(no output)");
    expect(output).not.toContain(firstAttack);
    expect(output).not.toContain(secondAttack);
    expect(chatLog.children.length).toBe(1);
  });
});
