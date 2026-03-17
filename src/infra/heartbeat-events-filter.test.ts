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
      name: "builds minimal cron wake prompt with safe token text",
      events: ["Cron: rotate logs"],
      expected: [
        "SYSTEM_WAKE source=cron",
        "token=Cron: rotate logs",
        "Reply HEARTBEAT_OK unless session context requires follow-up.",
      ],
      unexpected: [
        "A scheduled reminder has been triggered",
        "Please relay this reminder to the user",
        "Handle this reminder internally",
      ],
    },
    {
      name: "redacts unsafe reminder prose from cron wake prompt",
      events: [
        "Reminder: rotate logs.",
        "Please relay this reminder to the user in a helpful and friendly way.",
      ],
      expected: [
        "SYSTEM_WAKE source=cron",
        "Reply HEARTBEAT_OK unless session context requires follow-up.",
      ],
      unexpected: ["Reminder: rotate logs.", "Please relay this reminder to the user", "token="],
    },
    {
      name: "uses minimal fallback when cron content is empty",
      events: ["", "   "],
      expected: [
        "SYSTEM_WAKE source=cron",
        "Reply HEARTBEAT_OK unless session context requires follow-up.",
      ],
      unexpected: ["token=", "Please relay this reminder to the user"],
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
});

describe("heartbeat event classification", () => {
  it.each([
    { value: "exec finished: ok", expected: true },
    { value: "Exec Finished: failed", expected: true },
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
  ])("classifies cron system events for %j", ({ value, expected }) => {
    expect(isCronSystemEvent(value)).toBe(expected);
  });
});
