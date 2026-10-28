import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { ChatLog } from "./chat-log.js";

const lines = (log: ChatLog) =>
  log
    .render(80)
    .map((line) => normalizeTestText(line).trim())
    .filter(Boolean);

describe("ChatLog screen reader mode", () => {
  it("labels messages and drops decoration", () => {
    const log = new ChatLog(50, undefined, true);
    log.addSystem("connected");
    log.addUser("hi");
    log.finalizeAssistant("hello", "r1");
    expect(lines(log)).toEqual(["System: connected", "You: hi", "Assistant: hello"]);
    expect(log.render(80).join("\n")).not.toContain("\x1b[");
  });

  it("streams append-only: earlier lines never change and the partial line waits", () => {
    const log = new ChatLog(50, undefined, true);
    log.updateAssistant("one", "r1");
    expect(lines(log)).toEqual([]);
    log.updateAssistant("one\ntwo", "r1");
    const first = lines(log);
    expect(first).toEqual(["Assistant: one"]);
    log.updateAssistant("one\ntwo\nthree", "r1");
    const second = lines(log);
    expect(second.slice(0, first.length)).toEqual(first);
    log.finalizeAssistant("one\ntwo\nthree", "r1");
    const done = lines(log);
    expect(done.slice(0, second.length)).toEqual(second);
    expect(done.join("\n")).toContain("three");
  });

  it("holds the last wrapped row and never rewrites an announced one", () => {
    const log = new ChatLog(50, undefined, true);
    const first = "First sentence is here and it is rather long. Second one follows right away.";
    log.updateAssistant(`${first} Third`, "r1");
    const before = lines(log);
    expect(before).toEqual([
      "Assistant: First sentence is here and it is rather long. Second one follows",
    ]);
    log.updateAssistant(
      `${first} Third one is also long enough to wrap onto another row, and then a fourth row begins here.`,
      "r1",
    );
    const after = lines(log);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    log.finalizeAssistant(`${first} Third one ends.`, "r1");
    expect(lines(log).join(" ")).toContain("Third one ends.");
  });

  it("shows literal text unchanged", () => {
    const log = new ChatLog(50, undefined, true);
    log.finalizeAssistant('print("Hello! world")', "r1");
    expect(lines(log)).toEqual(['Assistant: print("Hello! world")']);
  });

  it("keeps numbered list items and abbreviations on one line", () => {
    const log = new ChatLog(50, undefined, true);
    log.finalizeAssistant("1. Install it\n2. Run it, e.g. now", "r1");
    expect(lines(log)).toEqual(["Assistant: 1. Install it", "2. Run it, e.g. now"]);
  });

  it("reveals the held-back sentence when the run fails", () => {
    const log = new ChatLog(50, undefined, true);
    log.updateAssistant("Done. Half a sen", "r1");
    expect(lines(log)).toEqual([]);
    log.finishAssistant("r1");
    expect(lines(log)).toEqual(["Assistant: Done. Half a sen"]);
  });

  it("flushes the partial line when a tool starts", () => {
    const log = new ChatLog(50, undefined, true);
    log.updateAssistant("partial", "r1");
    log.startTool("t1", "read_file", { path: "a" }, "r1");
    expect(lines(log).join("\n")).toContain("Assistant: partial");
  });

  it("keeps the default rendering unlabeled", () => {
    const log = new ChatLog(50);
    log.addUser("hi");
    expect(lines(log).join("\n")).not.toContain("You:");
  });
});

describe("tool cards in screen reader mode", () => {
  const start = (log: ChatLog) => log.startTool("t1", "read_file", { path: "a.txt" }, "r1");
  const text = (log: ChatLog) => lines(log).join("\n");

  it("carries state as text prefixes with no background or padding rows", () => {
    const log = new ChatLog(50, undefined, true);
    start(log);
    expect(text(log)).toContain("[running]");
    expect(log.render(80)[0]).toMatch(/^Tool /);
    log.updateToolResult("t1", { content: [{ type: "text", text: "done" }] });
    expect(text(log)).toContain("[ok]");
    expect(text(log)).not.toContain("[running]");
  });

  it("marks failures", () => {
    const log = new ChatLog(50, undefined, true);
    start(log);
    log.updateToolResult("t1", { content: [{ type: "text", text: "boom" }] }, { isError: true });
    expect(text(log)).toContain("[failed]");
  });

  it("keeps the default title format outside screen reader mode", () => {
    const log = new ChatLog(50);
    start(log);
    expect(text(log)).toContain("(running)");
    expect(text(log)).not.toContain("[running]");
  });
});
