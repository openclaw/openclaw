import { describe, expect, it } from "vitest";
import { parseContinuationSignal, stripContinuationSignal } from "./tokens.js";

describe("parseContinuationSignal", () => {
  it("returns null for empty text", () => {
    expect(parseContinuationSignal(undefined)).toBeNull();
    expect(parseContinuationSignal("")).toBeNull();
  });

  it("parses bare CONTINUE_WORK", () => {
    const signal = parseContinuationSignal("Some reply text\nCONTINUE_WORK");
    expect(signal).toEqual({ kind: "work", delayMs: undefined });
  });

  it("parses CONTINUE_WORK with delay", () => {
    const signal = parseContinuationSignal("Reply\nCONTINUE_WORK:30");
    expect(signal).toEqual({ kind: "work", delayMs: 30_000 });
  });

  it("parses CONTINUE_WORK:0 as zero delay", () => {
    const signal = parseContinuationSignal("CONTINUE_WORK:0");
    expect(signal).toEqual({ kind: "work", delayMs: 0 });
  });

  it("parses simple delegate bracket", () => {
    const signal = parseContinuationSignal(
      "Here is my reply.\n\n[[CONTINUE_DELEGATE: check CI status]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "check CI status",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
    });
  });

  it("parses delegate with delay", () => {
    const signal = parseContinuationSignal("Reply\n[[CONTINUE_DELEGATE: run tests +60s]]");
    expect(signal).toEqual({
      kind: "delegate",
      task: "run tests",
      delayMs: 60_000,
      silent: undefined,
      silentWake: undefined,
    });
  });

  it("parses delegate with silent mode", () => {
    const signal = parseContinuationSignal("[[CONTINUE_DELEGATE: background enrichment | silent]]");
    expect(signal).toEqual({
      kind: "delegate",
      task: "background enrichment",
      delayMs: undefined,
      silent: true,
      silentWake: undefined,
    });
  });

  it("parses delegate with silent-wake mode", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: check repo history | silent-wake]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "check repo history",
      delayMs: undefined,
      silent: undefined,
      silentWake: true,
    });
  });

  it("parses delegate with delay + silent-wake", () => {
    const signal = parseContinuationSignal(
      "Reply text\n[[CONTINUE_DELEGATE: delayed task +10s | silent-wake]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "delayed task",
      delayMs: 10_000,
      silent: undefined,
      silentWake: true,
    });
  });

  it("parses delegate target syntax", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: summarize sibling work | target=agent:main:root]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "summarize sibling work",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      targetSessionKey: "agent:main:root",
    });
  });

  it("parses delegate targets syntax", () => {
    const signal = parseContinuationSignal(
      "[[CONTINUE_DELEGATE: return to root and sibling | silent-wake | targets=agent:main:root, agent:main:sibling]]",
    );
    expect(signal).toEqual({
      kind: "delegate",
      task: "return to root and sibling",
      delayMs: undefined,
      silent: undefined,
      silentWake: true,
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });
  });

  it("parses delegate fanout syntax", () => {
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: return up chain | fanout=tree]]")).toEqual(
      {
        kind: "delegate",
        task: "return up chain",
        delayMs: undefined,
        silent: undefined,
        silentWake: undefined,
        fanoutMode: "tree",
      },
    );
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: return to host | fanout=all]]")).toEqual({
      kind: "delegate",
      task: "return to host",
      delayMs: undefined,
      silent: undefined,
      silentWake: undefined,
      fanoutMode: "all",
    });
  });

  it("rejects conflicting delegate target and fanout syntax", () => {
    expect(
      parseContinuationSignal(
        "[[CONTINUE_DELEGATE: ambiguous targeting | target=agent:main:root | fanout=tree]]",
      ),
    ).toBeNull();
  });

  it("does not match CONTINUE_WORK mid-text", () => {
    expect(parseContinuationSignal("I used CONTINUE_WORK earlier. Done now.")).toBeNull();
  });

  it("does not match partial bracket syntax", () => {
    expect(parseContinuationSignal("[[CONTINUE_DELEGATE: incomplete")).toBeNull();
  });

  it("truncates overly long task strings", () => {
    const longTask = "x".repeat(5000);
    const signal = parseContinuationSignal(`[[CONTINUE_DELEGATE: ${longTask}]]`);
    expect(signal?.kind).toBe("delegate");
    if (signal?.kind === "delegate") {
      expect(signal.task.length).toBe(4096);
    }
  });

  it("matches the LAST bracket when multiple appear", () => {
    const text =
      "Earlier I mentioned [[CONTINUE_DELEGATE: old task]]\n\n" +
      "Now the real one:\n[[CONTINUE_DELEGATE: actual task]]";
    const signal = parseContinuationSignal(text);
    expect(signal?.kind).toBe("delegate");
    if (signal?.kind === "delegate") {
      expect(signal.task).toBe("actual task");
    }
  });
});

describe("stripContinuationSignal", () => {
  it("returns original text when no signal present", () => {
    const result = stripContinuationSignal("Normal reply text.");
    expect(result).toEqual({ text: "Normal reply text.", signal: null });
  });

  it("strips CONTINUE_WORK from end", () => {
    const result = stripContinuationSignal("My reply\nCONTINUE_WORK");
    expect(result.signal).toEqual({ kind: "work", delayMs: undefined });
    expect(result.text).toBe("My reply");
  });

  it("strips CONTINUE_WORK:N from end", () => {
    const result = stripContinuationSignal("Reply\nCONTINUE_WORK:15");
    expect(result.signal?.kind).toBe("work");
    expect(result.text).toBe("Reply");
  });

  it("strips delegate bracket from end", () => {
    const result = stripContinuationSignal(
      "Here is the summary.\n\n[[CONTINUE_DELEGATE: verify tests]]",
    );
    expect(result.signal?.kind).toBe("delegate");
    expect(result.text).toBe("Here is the summary.");
  });

  it("preserves text before stripped signal", () => {
    const result = stripContinuationSignal(
      "Line 1\nLine 2\n\n[[CONTINUE_DELEGATE: task +5s | silent-wake]]",
    );
    expect(result.text).toBe("Line 1\nLine 2");
    expect(result.signal).toEqual({
      kind: "delegate",
      task: "task",
      delayMs: 5_000,
      silent: undefined,
      silentWake: true,
    });
  });
});
