import { expect, it } from "vitest";
import { shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
import { getAbortMemory, isAbortRequestText } from "./abort-primitives.js";
import { isAbortTrigger } from "./abort-trigger-text.js";

export function registerAbortDetectionCases(
  setTrackedAbortMemory: (key: string, value: boolean) => void,
) {
  it("isAbortTrigger matches standalone abort trigger phrases", () => {
    const positives = [
      "stop",
      "esc",
      "abort",
      "exit",
      "interrupt",
      "stop openclaw",
      "openclaw stop",
      "stop action",
      "stop current action",
      "stop run",
      "stop current run",
      "stop agent",
      "stop the agent",
      "stop don't do anything",
      "stop dont do anything",
      "stop do not do anything",
      "stop doing anything",
      "do not do that",
      "please stop",
      "stop please",
      "STOP OPENCLAW",
      "stop openclaw!!!",
      "stop don’t do anything",
      "detente",
      "detén",
      "arrête",
      "停止",
      "停下来",
      "暂停",
      "停下来！",
      "やめて",
      "止めて",
      "रुको",
      "توقف",
      "стоп",
      "остановись",
      "останови",
      "остановить",
      "прекрати",
      "halt",
      "anhalten",
      "aufhören",
      "hoer auf",
      "stopp",
      "pare",
    ];
    for (const candidate of positives) {
      expect(isAbortTrigger(candidate)).toBe(true);
    }

    expect(isAbortTrigger("hello")).toBe(false);
    expect(isAbortTrigger("wait")).toBe(false);
    expect(isAbortTrigger("please wait")).toBe(false);
    expect(isAbortTrigger("please do not do that")).toBe(false);
    // /stop is NOT matched by isAbortTrigger - it's handled separately.
    expect(isAbortTrigger("/stop")).toBe(false);
  });

  it("isAbortRequestText aligns abort command semantics", () => {
    expect(isAbortRequestText("/stop")).toBe(true);
    expect(isAbortRequestText("/STOP")).toBe(true);
    expect(isAbortRequestText("/stop!!!")).toBe(true);
    expect(isAbortRequestText("/Stop!!!")).toBe(true);
    expect(isAbortRequestText("stop")).toBe(true);
    expect(isAbortRequestText("Stop")).toBe(true);
    expect(isAbortRequestText("STOP")).toBe(true);
    expect(isAbortRequestText("stop action")).toBe(true);
    expect(isAbortRequestText("stop openclaw!!!")).toBe(true);
    expect(isAbortRequestText("停下来")).toBe(true);
    expect(isAbortRequestText("暂停")).toBe(true);
    expect(isAbortRequestText("やめて")).toBe(true);
    expect(isAbortRequestText("остановись")).toBe(true);
    expect(isAbortRequestText("halt")).toBe(true);
    expect(isAbortRequestText("stopp")).toBe(true);
    expect(isAbortRequestText("pare")).toBe(true);
    expect(isAbortRequestText(" توقف ")).toBe(true);
    expect(isAbortRequestText("/stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);
    expect(isAbortRequestText("/Stop@openclaw_bot", { botUsername: "openclaw_bot" })).toBe(true);
    expect(
      isAbortRequestText("/stop@unresolved_bot", {
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(true);
    expect(
      isAbortRequestText("/stop@unresolved_bot!", {
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(true);
    expect(
      isAbortRequestText("/queue@unresolved_bot", {
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(false);
    expect(
      isAbortRequestText("/stop@some_other_bot", {
        botUsername: "openclaw_bot",
        targetedCommandMode: "pre-identity",
      }),
    ).toBe(false);

    expect(isAbortRequestText("/status")).toBe(false);
    expect(isAbortRequestText("wait")).toBe(false);
    expect(isAbortRequestText("please wait")).toBe(false);
    expect(isAbortRequestText("do not do that")).toBe(true);
    expect(isAbortRequestText("please do not do that")).toBe(false);
    expect(isAbortRequestText("/abort")).toBe(false);
  });

  it("removes abort memory entry when flag is reset", () => {
    setTrackedAbortMemory("session-1", true);
    expect(getAbortMemory("session-1")).toBe(true);

    setTrackedAbortMemory("session-1", false);
    expect(getAbortMemory("session-1")).toBeUndefined();
  });

  it("caps abort memory tracking to a bounded max size", () => {
    for (let i = 0; i < 2105; i += 1) {
      setTrackedAbortMemory(`bounded-memory-session-${i}`, true);
    }
    expect(getAbortMemory("bounded-memory-session-0")).toBeUndefined();
    expect(getAbortMemory("bounded-memory-session-2104")).toBe(true);
  });

  it("treats numeric message IDs at or before cutoff as stale", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "199",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "200",
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffMessageSid: "200",
        messageSid: "201",
      }),
    ).toBe(false);
  });

  it("falls back to timestamp cutoff when message IDs are unavailable", () => {
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 1999,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2000,
      }),
    ).toBe(true);
    expect(
      shouldSkipMessageByAbortCutoff({
        cutoffTimestamp: 2000,
        timestamp: 2001,
      }),
    ).toBe(false);
  });
}
