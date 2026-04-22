import { describe, expect, it } from "vitest";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
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
      name: "builds user-relay exec prompt by default",
      opts: undefined,
      expected: ["Please relay the command output to the user", "If it failed"],
      unexpected: ["Handle the result internally"],
    },
    {
      name: "builds internal-only exec prompt when delivery is disabled",
      opts: { deliverToUser: false },
      expected: ["Handle the result internally"],
      unexpected: ["Please relay the command output to the user"],
    },
  ])("$name", ({ opts, expected, unexpected }) => {
    const prompt = buildExecEventPrompt(opts);
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected) {
      expect(prompt).not.toContain(part);
    }
  });

  it("frames exec events as assistant-started, not user-initiated (#70373)", () => {
    // Regression: the previous wording ("An async command you ran earlier")
    // trained the agent to parrot that phrasing back to the user, so
    // assistant-started background work read as user-initiated in the
    // Control UI transcript. The new wording must (a) mention the
    // assistant as the originator, (b) NOT contain the old misleading
    // phrase, for both delivery modes.
    for (const deliverToUser of [true, false]) {
      const prompt = buildExecEventPrompt({ deliverToUser });
      expect(prompt).toContain("you (the assistant)");
      expect(prompt).not.toContain("async command you ran earlier");
    }
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
