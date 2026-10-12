// Chat log tests cover message rendering order and layout behavior.
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ChatLog } from "./chat-log.js";
import { MarkdownMessageComponent } from "./markdown-message.js";

describe("ChatLog", () => {
  it("coalesces consecutive repeatable system messages", () => {
    const chatLog = new ChatLog(20);
    const rawText = "\x1b[?7777h\x1b]52;c;T08_CHAT_LOG_ONLY_CONTROLS\x07";

    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    chatLog.addSystem(rawText, { coalesceConsecutive: true });
    chatLog.addSystem(rawText, { coalesceConsecutive: true });

    const raw = chatLog.render(120).join("\n");
    const rendered = normalizeTestText(raw);
    expect(chatLog.children.length).toBe(1);
    expect(rendered).toContain("(no output) x3");
    expect(raw).not.toContain(rawText);
  });

  it("does not coalesce distinct raw system messages that sanitize identically", () => {
    const chatLog = new ChatLog(20);

    chatLog.addSystem("\x1b[?7776h", { coalesceConsecutive: true });
    chatLog.addSystem("\u009b777;888H", { coalesceConsecutive: true });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(2);
    expect(rendered.match(/\(no output\)/g)).toHaveLength(2);
    expect(rendered).not.toContain("x2");
  });

  it("drops stale streaming references when old components are pruned", () => {
    const chatLog = new ChatLog(20);
    chatLog.updateAssistant("first", "run-1");
    for (let i = 0; i < 25; i++) {
      chatLog.addSystem(`overflow-${i}`);
    }

    // Should not throw if the original streaming component was pruned.
    chatLog.updateAssistant("recreated", "run-1");

    const rendered = chatLog.render(120).join("\n");
    expect(chatLog.children.length).toBe(20);
    expect(rendered).toContain("recreated");
  });

  it("reconciles a revised final snapshot after multiple frozen tool calls", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("First segment.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("First segment.\n\nSecond segment.", "run-1");
    chatLog.startTool("tool-2", "read_file", { path: "b.txt" });
    chatLog.finalizeAssistant("Revised first segment.\n\nFinal answer.", "run-1");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered.split("Revised first segment.")).toHaveLength(2);
    expect(rendered.split("Final answer.")).toHaveLength(2);
    expect(rendered).not.toContain("Second segment.");
    expect(
      chatLog.children.map((component) =>
        component instanceof MarkdownMessageComponent ? component.role : component.constructor.name,
      ),
    ).toEqual(["ToolExecutionComponent", "ToolExecutionComponent", "assistant"]);
    expect(rendered.lastIndexOf("Read File")).toBeLessThan(rendered.indexOf("Final answer."));
  });

  it("removes frozen provisional text when the final snapshot retracts it", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Retracted provisional answer.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.finalizeAssistant("", "run-1");

    expect(normalizeTestText(chatLog.render(120).join("\n"))).not.toContain(
      "Retracted provisional answer.",
    );
    expect(
      chatLog.children.map((component) =>
        component instanceof MarkdownMessageComponent ? component.role : component.constructor.name,
      ),
    ).toEqual(["ToolExecutionComponent"]);
  });

  it("clears frozen assistant segments when the chat history is rebuilt", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Before the tool.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.clearAll();
    chatLog.updateAssistant("Before the tool.\n\nNew history.", "run-1");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Before the tool.");
    expect(rendered).toContain("New history.");
    expect(chatLog.children).toHaveLength(1);
  });

  it("removes every frozen assistant segment when a tool-using run is dropped", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("First segment.", "run-1");
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateAssistant("First segment.\n\nSecond segment.", "run-1");
    chatLog.startTool("tool-2", "read_file", { path: "b.txt" });
    chatLog.updateAssistant("First segment.\n\nSecond segment.\n\nThird segment.", "run-1");

    const beforeDrop = normalizeTestText(chatLog.render(120).join("\n"));
    for (const text of ["First segment.", "Second segment.", "Third segment."]) {
      expect(beforeDrop.split(text)).toHaveLength(2);
    }
    expect(beforeDrop.indexOf("First segment.")).toBeLessThan(beforeDrop.indexOf("a.txt"));
    expect(beforeDrop.indexOf("a.txt")).toBeLessThan(beforeDrop.indexOf("Second segment."));
    expect(beforeDrop.indexOf("Second segment.")).toBeLessThan(beforeDrop.indexOf("b.txt"));
    expect(beforeDrop.indexOf("b.txt")).toBeLessThan(beforeDrop.indexOf("Third segment."));

    chatLog.dropAssistant("run-1");

    expect(
      chatLog.children.map((component) =>
        component instanceof MarkdownMessageComponent ? component.role : component.constructor.name,
      ),
    ).toEqual(["ToolExecutionComponent", "ToolExecutionComponent"]);
    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toContain("First segment.");
    expect(rendered).not.toContain("Second segment.");
    expect(rendered).not.toContain("Third segment.");

    chatLog.updateAssistant("Fresh run.", "run-1");
    expect(normalizeTestText(chatLog.render(120).join("\n"))).toContain("Fresh run.");
  });

  it("reserves assistant position without clearing existing streamed text", () => {
    const chatLog = new ChatLog(40);
    chatLog.updateAssistant("partial", "run-active");
    chatLog.reserveAssistantSlot("run-active");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("partial");
    expect(chatLog.children.length).toBe(1);
  });

  it("clears visible tool entries and stale tool references", () => {
    const chatLog = new ChatLog(20);
    chatLog.startTool("tool-1", "read_file", { path: "a.txt" });
    chatLog.updateToolResult("tool-1", { content: [{ type: "text", text: "done" }] });

    let rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Read File");

    chatLog.clearTools();
    chatLog.updateToolResult("tool-1", { content: [{ type: "text", text: "stale" }] });

    rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).not.toContain("Read File");
    expect(rendered).not.toContain("stale");
  });

  it("prunes system messages atomically when a non-system entry overflows the log", () => {
    const chatLog = new ChatLog(20);
    for (let i = 1; i <= 20; i++) {
      chatLog.addSystem(`system-${i}`);
    }

    chatLog.addUser("hello");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
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

  it("clears user and pending component references before the next projected session", () => {
    const chatLog = new ChatLog(40);

    chatLog.addLiveUser("Previous session prompt.", { messageId: "previous-user" });
    chatLog.addPendingUser("previous-run", "Previous pending prompt.");
    chatLog.clearAll();
    chatLog.addUser("Selected session prompt.", { messageId: "selected-user" });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Selected session prompt.");
    expect(rendered).not.toContain("Previous session prompt.");
    expect(rendered).not.toContain("Previous pending prompt.");
    expect(chatLog.countPendingUsers()).toBe(0);
    expect(chatLog.children).toHaveLength(1);
  });

  it("updates a pending viewport component in place for the same run", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "Original pending prompt.");
    chatLog.addPendingUser("run-1", "Updated pending prompt.");

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(1);
    expect(chatLog.countPendingUsers()).toBe(1);
    expect(rendered).toContain("Updated pending prompt.");
    expect(rendered).not.toContain("Original pending prompt.");
  });

  it("keeps scrollback bounded when every visible tool belongs to the delayed prompt's run", () => {
    const chatLog = new ChatLog(20);
    chatLog.updateAssistant("Reply with many tools.", "shared-run");
    for (let index = 0; index < 19; index += 1) {
      chatLog.startTool(
        `shared-tool-${index}`,
        "read_file",
        { path: `shared-${index}.txt` },
        "shared-run",
      );
    }

    chatLog.addLiveUser("Authoritative prompt before many tools.", {
      messageId: "shared-user",
      runId: "shared-run",
    });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(20);
    expect(rendered.match(/Authoritative prompt before many tools\./g)).toHaveLength(1);
    expect(rendered.indexOf("Authoritative prompt before many tools.")).toBeLessThan(
      rendered.indexOf("Reply with many tools."),
    );
    expect(rendered).not.toContain("shared-0.txt");
    expect(rendered).toContain("shared-18.txt");

    chatLog.updateToolResult("shared-tool-0", {
      content: [{ type: "text", text: "evicted tool must stay detached" }],
    });
    expect(chatLog.children).toHaveLength(20);
    expect(chatLog.render(120).join("\n")).not.toContain("evicted tool must stay detached");
  });

  it.each([
    { phase: "tool-finished", capacity: 20 },
    { phase: "tool-finished-retracted-tail", capacity: 20 },
  ])(
    "orders a delayed prompt before a $phase reply at capacity $capacity",
    ({ phase, capacity }) => {
      const chatLog = new ChatLog(capacity);
      const runId = `shared-${phase}-${capacity}`;
      chatLog.updateAssistant("First reply segment.", runId);

      chatLog.startTool(`${runId}-tool`, "read_file", { path: "shared.txt" });
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

      const rendered = normalizeTestText(chatLog.render(120).join("\n"));
      expect(chatLog.children).toHaveLength(capacity);
      expect(rendered.match(/Authoritative shared prompt\./g)).toHaveLength(1);
      expect(rendered.indexOf("Authoritative shared prompt.")).toBeLessThan(
        rendered.indexOf("First reply segment."),
      );
      if (phase === "tool-finished") {
        expect(rendered).toContain("Last reply segment.");
      } else {
        expect(rendered).not.toContain("Last reply segment.");
      }
    },
  );

  it("orders a delayed prompt before owned tools after all assistants are evicted", () => {
    const capacity = 20;
    const chatLog = new ChatLog(capacity);
    const runId = "evicted-all-assistants";

    chatLog.updateAssistant("First evicted reply segment.", runId);
    chatLog.startTool(`${runId}-first-tool`, "read_file", { path: "first-shared.txt" }, runId);
    chatLog.updateAssistant("First evicted reply segment.\n\nLast evicted reply segment.", runId);
    chatLog.startTool(`${runId}-last-tool`, "read_file", { path: "last-shared.txt" }, runId);
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

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered.match(/Delayed prompt before surviving tools\./g)).toHaveLength(1);
    expect(rendered.indexOf("Delayed prompt before surviving tools.")).toBeLessThan(
      rendered.indexOf("last-shared.txt"),
    );
    expect(rendered).not.toContain("Last evicted reply segment.");
  });

  it("retains an executing tool while reserving a delayed prompt at capacity 20", () => {
    const capacity = 20;
    const chatLog = new ChatLog(capacity);
    const runId = `active-tool-${capacity}`;
    let assistantText = "";

    for (let index = 0; index < capacity - 1; index += 1) {
      assistantText += `${index === 0 ? "" : "\n\n"}Running reply segment ${index}.`;
      chatLog.updateAssistant(assistantText, runId);
      chatLog.startTool(
        `${runId}-previous-tool-${index}`,
        "read_file",
        { path: `previous-${index}.txt` },
        runId,
      );
      chatLog.clearTools();
    }

    const activeToolId = `${runId}-active-tool`;
    chatLog.startTool(activeToolId, "read_file", { path: "still-running.txt" }, runId);
    chatLog.addLiveUser("Delayed prompt during active tool.", {
      messageId: `${runId}-user`,
      runId,
    });
    chatLog.updateToolResult(
      activeToolId,
      { content: [{ type: "text", text: "Visible partial tool output." }] },
      { partial: true },
    );

    let rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered).toContain("Visible partial tool output.");
    expect(rendered.indexOf("Delayed prompt during active tool.")).toBeLessThan(
      rendered.indexOf("Running reply segment 0."),
    );

    chatLog.updateToolResult(activeToolId, {
      content: [{ type: "text", text: "Visible final tool output." }],
    });
    rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(rendered).toContain("Visible final tool output.");
    expect(chatLog.children).toHaveLength(capacity);
  });

  it("preserves both a streaming reply and an executing tool at full capacity 20", () => {
    const capacity = 20;
    const chatLog = new ChatLog(capacity);
    const runId = `live-components-${capacity}`;
    chatLog.updateAssistant("First preserved live reply.", runId);

    const activeToolId = `${runId}-active-tool`;
    for (let index = 0; index < capacity - 2; index += 1) {
      const toolId = index === 0 ? activeToolId : `${runId}-completed-tool-${index}`;
      chatLog.startTool(toolId, "read_file", { path: `live-tool-${index}.txt` }, runId);
      if (index > 0) {
        chatLog.updateToolResult(toolId, {
          content: [{ type: "text", text: `Completed historical tool ${index}.` }],
        });
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
    chatLog.updateToolResult(
      activeToolId,
      { content: [{ type: "text", text: "Live tool progress remains visible." }] },
      { partial: true },
    );
    chatLog.updateAssistant("First preserved live reply.\n\nUpdated streaming reply.", runId);

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered.match(/Delayed prompt during live components\./g)).toHaveLength(1);
    expect(rendered.indexOf("Delayed prompt during live components.")).toBeLessThan(
      rendered.indexOf("First preserved live reply."),
    );
    expect(rendered).toContain("Live tool progress remains visible.");
    expect(rendered).toContain("Updated streaming reply.");
    expect(rendered).not.toContain("Completed historical tool 1.");
  });

  it("evicts a completed first segment before an executing tool at capacity 20", () => {
    const capacity = 20;
    const chatLog = new ChatLog(capacity);
    const runId = `only-completed-anchor-${capacity}`;
    chatLog.updateAssistant("Only completed reply segment.", runId);

    for (let index = 0; index < capacity - 2; index += 1) {
      chatLog.startTool(
        `${runId}-active-tool-${index}`,
        "read_file",
        { path: `active-only-${index}.txt` },
        runId,
      );
    }
    chatLog.updateAssistant("Only completed reply segment.\n\nProtected live reply.", runId);
    chatLog.addLiveUser("Delayed prompt before concurrent tools.", {
      messageId: `${runId}-user`,
      runId,
    });

    for (const index of [0, capacity - 3]) {
      chatLog.updateToolResult(
        `${runId}-active-tool-${index}`,
        { content: [{ type: "text", text: `Protected active tool ${index}.` }] },
        { partial: true },
      );
    }

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children).toHaveLength(capacity);
    expect(rendered.match(/Delayed prompt before concurrent tools\./g)).toHaveLength(1);
    expect(rendered).not.toContain("Only completed reply segment.");
    expect(rendered).toContain("Protected live reply.");
    expect(rendered).toContain("Protected active tool 0.");
    expect(rendered).toContain(`Protected active tool ${capacity - 3}.`);
  });

  it("dismisses a pending system notice by runId", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingSystem("run-1", "taking longer than expected");
    let rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("taking longer than expected");

    const dismissed = chatLog.dismissPendingSystem("run-1");
    expect(dismissed).toBe(true);

    rendered = chatLog.render(120).join("\n");
    expect(rendered).not.toContain("taking longer than expected");
    expect(chatLog.dismissPendingSystem("run-1")).toBe(false);
  });

  it("replaces an existing pending system notice for the same runId", () => {
    const chatLog = new ChatLog(40);
    const firstAttack = "\x1b]52;c;T08_PENDING_FIRST\x07";
    const secondAttack = "\u009d0;T08_PENDING_SECOND\u009c";

    chatLog.addPendingSystem("run-1", `first ${firstAttack}notice`);
    chatLog.addPendingSystem("run-1", secondAttack);

    const raw = chatLog.render(120).join("\n");
    const rendered = normalizeTestText(raw);
    expect(rendered).not.toContain("first notice");
    expect(rendered).toContain("(no output)");
    expect(raw).not.toContain(firstAttack);
    expect(raw).not.toContain(secondAttack);
    expect(chatLog.children.length).toBe(1);
  });
});
