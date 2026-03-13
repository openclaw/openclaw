import { describe, expect, it } from "vitest";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isExecCompletionEvent,
} from "./heartbeat-events-filter.js";

describe("heartbeat event prompts", () => {
  it("builds user-relay cron prompt by default", () => {
    const prompt = buildCronEventPrompt(["Cron: rotate logs"]);
    expect(prompt).toContain("Please relay this reminder to the user");
  });

  it("builds internal-only cron prompt when delivery is disabled", () => {
    const prompt = buildCronEventPrompt(["Cron: rotate logs"], { deliverToUser: false });
    expect(prompt).toContain("Handle this reminder internally");
    expect(prompt).not.toContain("Please relay this reminder to the user");
  });

  it("builds internal-only exec prompt when delivery is disabled", () => {
    const prompt = buildExecEventPrompt({ deliverToUser: false });
    expect(prompt).toContain("Handle the result internally");
    expect(prompt).not.toContain("Please relay the command output to the user");
  });
});

describe("isExecCompletionEvent", () => {
  it("matches emitExecSystemEvent (gateway/node approval path) events", () => {
    expect(isExecCompletionEvent("Exec finished (gateway id=g1, session=s1, code 0)")).toBe(true);
    expect(isExecCompletionEvent("exec finished (node=n1, code 1)\nsome output")).toBe(true);
  });

  it("matches maybeNotifyOnExit (backgrounded allowlisted commands) events", () => {
    expect(isExecCompletionEvent("Exec completed (abc12345, code 0) :: some output")).toBe(true);
    expect(isExecCompletionEvent("Exec completed (abc12345, code 0)")).toBe(true);
    expect(isExecCompletionEvent("Exec failed (abc12345, code 1) :: error text")).toBe(true);
    expect(isExecCompletionEvent("Exec failed (abc12345, signal SIGTERM)")).toBe(true);
    expect(isExecCompletionEvent("Exec killed (abc12345, signal SIGKILL)")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isExecCompletionEvent("EXEC COMPLETED (abc12345, code 0)")).toBe(true);
    expect(isExecCompletionEvent("exec failed (abc12345, code 2)")).toBe(true);
  });

  it("does not match non-exec events", () => {
    expect(isExecCompletionEvent("Exec running (gateway id=g1, session=s1, >5s): ls")).toBe(false);
    expect(isExecCompletionEvent("Exec denied (gateway id=g1, reason): rm -rf /")).toBe(false);
    expect(isExecCompletionEvent("Heartbeat wake")).toBe(false);
    expect(isExecCompletionEvent("")).toBe(false);
  });
});
