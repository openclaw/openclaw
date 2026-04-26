import { describe, expect, it } from "vitest";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
  isSuccessfulExecCompletionEvent,
  shouldRelayExecCompletionEvents,
} from "./heartbeat-events-filter.js";

describe("heartbeat event prompts", () => {
  it.each([
    {
      name: "builds user-relay cron prompt by default",
      events: ["Cron: rotate logs"],
      expected: ["Cron: rotate logs", "Please relay this reminder to the user"],
      unexpected: ["Handle this reminder internally", "Reply HEARTBEAT_OK."],
    },
    {
      name: "builds internal-only cron prompt when delivery is disabled",
      events: ["Cron: rotate logs"],
      opts: { deliverToUser: false },
      expected: ["Cron: rotate logs", "Handle this reminder internally"],
      unexpected: ["Please relay this reminder to the user"],
    },
    {
      name: "falls back to bare heartbeat reply when cron content is empty",
      events: ["", "   "],
      expected: ["Reply HEARTBEAT_OK."],
      unexpected: ["Handle this reminder internally"],
    },
    {
      name: "uses internal empty-content fallback when delivery is disabled",
      events: ["", "   "],
      opts: { deliverToUser: false },
      expected: ["Handle this internally", "HEARTBEAT_OK when nothing needs user-facing follow-up"],
      unexpected: ["Please relay this reminder to the user"],
    },
  ])("$name", ({ events, opts, expected, unexpected }) => {
    const prompt = buildCronEventPrompt(events, opts);
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected) {
      expect(prompt).not.toContain(part);
    }
  });

  it.each([
    {
      name: "keeps structured successful exec completions internal by default",
      events: ["Exec completed (abc12345, code 0) :: tests passed"],
      opts: undefined,
      expected: ["completed successfully", "reply HEARTBEAT_OK only"],
      unexpected: ["tests passed", "Please relay the command output to the user"],
    },
    {
      name: "builds user-relay exec prompt by default",
      events: ["Exec failed (abc12345, code 1) :: Upload failed"],
      opts: undefined,
      expected: [
        "Exec failed",
        "Upload failed",
        "Please relay the command output to the user",
        "If it failed",
      ],
      unexpected: ["system messages above", "Handle the result internally"],
    },
    {
      name: "builds internal-only exec prompt when delivery is disabled",
      events: ["Exec failed (node=abc id=123, code 1)\nUpload failed"],
      opts: { deliverToUser: false },
      expected: ["user delivery is disabled", "Handle the result internally", "HEARTBEAT_OK only"],
      unexpected: [
        "Upload failed",
        "system messages above",
        "Please relay the command output to the user",
      ],
    },
    {
      name: "suppresses empty exec completion prompts",
      events: ["", "   "],
      opts: undefined,
      expected: ["no command output was found", "Reply HEARTBEAT_OK only"],
      unexpected: ["Please relay the command output to the user", "system messages above"],
    },
  ])("$name", ({ events, opts, expected, unexpected }) => {
    const prompt = buildExecEventPrompt(events, opts);
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected) {
      expect(prompt).not.toContain(part);
    }
  });

  it("truncates oversized user-relay exec prompt output", () => {
    const prompt = buildExecEventPrompt([`Exec failed (abc12345, code 1) :: ${"x".repeat(8_100)}`]);

    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(8_500);
  });

  it("strips successful exec completion output from mixed user-relay batches", () => {
    const prompt = buildExecEventPrompt([
      "Exec completed (success1, code 0) :: secret success output",
      "Exec failed (failed1, code 1) :: actionable failure",
    ]);

    expect(prompt).toContain("Exec failed");
    expect(prompt).toContain("actionable failure");
    expect(prompt).not.toContain("secret success output");
  });

  it("only relays exec completions with failures or ambiguous legacy status", () => {
    expect(shouldRelayExecCompletionEvents(["Exec completed (abc12345, code 0) :: ok"])).toBe(
      false,
    );
    expect(shouldRelayExecCompletionEvents(["Exec failed (abc12345, code 1) :: failed"])).toBe(
      true,
    );
    expect(shouldRelayExecCompletionEvents(["Exec completed (abc12345, signal SIGTERM)"])).toBe(
      true,
    );
    expect(shouldRelayExecCompletionEvents(["Exec finished: legacy completion"])).toBe(true);
  });
});

describe("heartbeat event classification", () => {
  it.each([
    { value: "exec finished: ok", expected: true },
    { value: "Exec finished (node=abc, code 0)", expected: true },
    { value: "Exec Finished (node=abc, code 1)", expected: true },
    { value: "Exec completed (abc12345, code 0) :: some output", expected: true },
    { value: "Exec failed (abc12345, signal SIGTERM) :: error output", expected: true },
    { value: "Exec completed (rotate api keys)", expected: false },
    { value: "Exec failed: notify me if this happens", expected: false },
    { value: "Reminder: if exec failed, notify me", expected: false },
    { value: "cron finished", expected: false },
  ])("classifies exec completion events for %j", ({ value, expected }) => {
    expect(isExecCompletionEvent(value)).toBe(expected);
  });

  it.each([
    { value: "Exec completed (abc12345, code 0)", expected: true },
    { value: "Exec completed (abc12345, code 0) :: output", expected: true },
    { value: "Exec completed (abc12345, code 1)", expected: false },
    { value: "Exec failed (abc12345, code 0)", expected: false },
    { value: "Exec finished: legacy completion", expected: false },
  ])("classifies successful exec completion events for %j", ({ value, expected }) => {
    expect(isSuccessfulExecCompletionEvent(value)).toBe(expected);
  });

  it.each([
    { value: "Cron: rotate logs", expected: true },
    { value: "  Cron: rotate logs  ", expected: true },
    { value: "", expected: false },
    { value: "   ", expected: false },
    { value: "HEARTBEAT_OK", expected: false },
    { value: "heartbeat_ok: already handled", expected: false },
    { value: "heartbeat poll: noop", expected: false },
    { value: "heartbeat wake: noop", expected: false },
    { value: "exec finished: ok", expected: false },
    { value: "Exec finished (node=abc, code 0)", expected: false },
    { value: "Exec completed (abc12345, code 0) :: some output", expected: false },
    { value: "Exec failed (abc12345, signal SIGTERM) :: error output", expected: false },
    { value: "Exec completed (rotate api keys)", expected: true },
    { value: "Reminder: if exec failed, notify me", expected: true },
  ])("classifies cron system events for %j", ({ value, expected }) => {
    expect(isCronSystemEvent(value)).toBe(expected);
  });
});
