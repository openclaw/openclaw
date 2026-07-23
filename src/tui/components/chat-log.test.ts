// Chat log tests cover message rendering order and layout behavior.
import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
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

  it("coalesces consecutive repeatable system messages", () => {
    const chatLog = new ChatLog(20);

    chatLog.addSystem("no active run", { coalesceConsecutive: true });
    chatLog.addSystem("no active run", { coalesceConsecutive: true });
    chatLog.addSystem("no active run", { coalesceConsecutive: true });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(1);
    expect(rendered).toContain("no active run x3");
  });

  it("does not coalesce ordinary system messages", () => {
    const chatLog = new ChatLog(20);

    chatLog.addSystem("status unchanged");
    chatLog.addSystem("status unchanged");

    expect(chatLog.children.length).toBe(2);
  });

  it("starts a new repeatable system message after other chat content", () => {
    const chatLog = new ChatLog(20);

    chatLog.addSystem("no active run", { coalesceConsecutive: true });
    chatLog.addUser("hello");
    chatLog.addSystem("no active run", { coalesceConsecutive: true });

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(3);
    expect(rendered).not.toContain("no active run x2");
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

  it("renders assistant text after a mid-run tool call below the tool card, not above it", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Let me check that for you.", "run-1");
    chatLog.startTool("tool-1", "bash", { command: "ls" });
    chatLog.updateToolResult("tool-1", { content: [{ type: "text", text: "file1\nfile2" }] });
    // Same runId: the underlying run streams one cumulative buffer across the
    // whole tool-calling loop, so this includes the pre-tool text too.
    chatLog.updateAssistant(
      "Let me check that for you.\n\nHere's what I found: file1, file2.",
      "run-1",
    );

    expect(chatLog.children.map((c) => c.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    const preToolIndex = rendered.indexOf("Let me check that for you.");
    const toolIndex = rendered.indexOf("Bash");
    const postToolIndex = rendered.indexOf("Here's what I found");
    expect(preToolIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(preToolIndex);
    expect(postToolIndex).toBeGreaterThan(toolIndex);
  });

  it("does not duplicate earlier segments across a second mid-run tool call", () => {
    const chatLog = new ChatLog(40);

    chatLog.updateAssistant("Sure, let me look.", "run-1");
    chatLog.startTool("tool-1", "bash", { command: "ls" });
    chatLog.updateToolResult("tool-1", { content: [{ type: "text", text: "a.txt" }] });
    chatLog.updateAssistant("Sure, let me look.\n\nAlright, found a file.", "run-1");
    chatLog.startTool("tool-2", "bash", { command: "cat a.txt" });
    chatLog.updateToolResult("tool-2", { content: [{ type: "text", text: "hello" }] });
    chatLog.updateAssistant(
      "Sure, let me look.\n\nAlright, found a file.\n\nIt says hello.",
      "run-1",
    );

    expect(chatLog.children.map((c) => c.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    const occurrences = (needle: string) => rendered.split(needle).length - 1;
    expect(occurrences("Sure, let me look.")).toBe(1);
    expect(occurrences("Alright, found a file.")).toBe(1);
    expect(occurrences("It says hello.")).toBe(1);
  });

  it("reserves assistant position without clearing existing streamed text", () => {
    const chatLog = new ChatLog(40);
    chatLog.startAssistant("partial", "run-active");
    chatLog.reserveAssistantSlot("run-active");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("partial");
    expect(chatLog.children.length).toBe(1);
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

  it("shows a one-line fuzzy activity summary that updates in place as tools run", () => {
    const chatLog = new ChatLog(40);

    chatLog.recordToolActivity("run-1", "read", "tool-1");
    let rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("Read a file");
    expect(chatLog.children.length).toBe(1);

    chatLog.recordToolActivity("run-1", "bash", "tool-2");
    rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("Read a file and ran a command");
    // Same run, same component: updates in place instead of adding a new row.
    expect(chatLog.children.length).toBe(1);
  });

  it("does not double-count a repeated start event for the same tool call", () => {
    const chatLog = new ChatLog(40);

    chatLog.recordToolActivity("run-1", "read", "tool-1");
    chatLog.recordToolActivity("run-1", "read", "tool-1");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("Read a file");
    expect(rendered).not.toContain("Read 2 files");
  });

  it("does not duplicate assistant text when history replay crosses tool boundaries", () => {
    // Simulates loadHistory() replay: updateAssistant() for assistant messages,
    // startTool() for tool results. Before the fix, the cumulative text from
    // a run that spans tool calls would duplicate the pre-tool portion.
    const chatLog = new ChatLog(40);

    // Replay: assistant says something, then a tool call happens.
    chatLog.updateAssistant("Let me look into that.", "replay-run");
    chatLog.startTool("t1", "bash", { command: "ls" });
    chatLog.updateToolResult("t1", { content: [{ type: "text", text: "a.txt b.txt" }] });
    // Replay: assistant continues with cumulative text (includes pre-tool part).
    chatLog.updateAssistant("Let me look into that.\n\nFound a.txt and b.txt.", "replay-run");
    chatLog.startTool("t2", "bash", { command: "cat a.txt" });
    chatLog.updateToolResult("t2", { content: [{ type: "text", text: "hello world" }] });
    // Replay: final assistant message with full cumulative text.
    chatLog.updateAssistant(
      "Let me look into that.\n\nFound a.txt and b.txt.\n\nIt says hello world.",
      "replay-run",
    );

    // Clean up streaming state as loadHistory does after replay.
    chatLog["committedTextByRun"].clear();
    chatLog["lastFullTextByRun"].clear();
    chatLog["streamingRuns"].clear();

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    const occurrences = (needle: string) => rendered.split(needle).length - 1;
    // Each segment should appear exactly once — no duplication.
    expect(occurrences("Let me look into that.")).toBe(1);
    expect(occurrences("Found a.txt and b.txt.")).toBe(1);
    expect(occurrences("It says hello world.")).toBe(1);
    // Correct ordering: pre-tool text, tool, post-tool text, tool, final text.
    expect(chatLog.children.map((c) => c.constructor.name)).toEqual([
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
      "ToolExecutionComponent",
      "AssistantMessageComponent",
    ]);
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

  it("preserves pending user messages across history rebuilds", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello");
    chatLog.clearAll({ preservePendingUsers: true });
    chatLog.addSystem("session agent:main:main");
    chatLog.restorePendingUsers();

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).toContain("queued hello");
    expect(chatLog.countPendingUsers()).toBe(1);
  });

  it("does not append the same pending component twice when it is already mounted", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello");
    chatLog.restorePendingUsers();

    expect(chatLog.children.length).toBe(1);
    expect(chatLog.render(120).join("\n")).toContain("queued hello");
  });

  it("re-keys a pending user in place without moving its position", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("local", "queued hello", 1_000);
    chatLog.startAssistant("hi there", "r-accepted");

    expect(chatLog.rekeyPendingUser("local", "r-accepted")).toBe(true);

    const rendered = chatLog.render(120).join("\n");
    expect(rendered.indexOf("queued hello")).toBeLessThan(rendered.indexOf("hi there"));
    // The row is now addressable by the gateway-assigned runId.
    expect(chatLog.dropPendingUser("r-accepted")).toBe(true);
    expect(chatLog.countPendingUsers()).toBe(0);
  });

  it("reconciles pending users against rebuilt history using timestamps", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello", 2_000);

    expect(
      chatLog.reconcilePendingUsers([
        { text: "queued hello", timestamp: 2_100 },
        { text: "older", timestamp: 1_000 },
      ]),
    ).toEqual(["run-1"]);
    expect(chatLog.countPendingUsers()).toBe(0);
  });

  it("reconciles pending users when the gateway clock is slightly behind the client", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "queued hello", 65_000);

    expect(chatLog.reconcilePendingUsers([{ text: "queued hello", timestamp: 20_000 }])).toEqual([
      "run-1",
    ]);
    expect(chatLog.countPendingUsers()).toBe(0);
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

    chatLog.addPendingSystem("run-1", "first notice");
    chatLog.addPendingSystem("run-1", "second notice");

    const rendered = chatLog.render(120).join("\n");
    expect(rendered).not.toContain("first notice");
    expect(rendered).toContain("second notice");
    expect(chatLog.children.length).toBe(1);
  });

  it("does not hide a new repeated prompt when only older history matches", () => {
    const chatLog = new ChatLog(40);

    chatLog.addPendingUser("run-1", "continue", 5_000);

    expect(chatLog.reconcilePendingUsers([{ text: "continue", timestamp: -56_000 }])).toStrictEqual(
      [],
    );
    expect(chatLog.countPendingUsers()).toBe(1);
  });
});
