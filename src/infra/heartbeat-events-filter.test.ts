// Covers heartbeat event prompt filtering.
import { describe, expect, it } from "vitest";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  buildSlackInteractionEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
  isRelayableExecCompletionEvent,
  isSlackInteractionEvent,
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
      events: ["Exec finished (node=abc id=123, code 0)\nUploaded file"],
      opts: undefined,
      expected: [
        "Exec finished",
        "Uploaded file",
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
    {
      name: "suppresses metadata-only successful exec completions",
      events: ["Exec completed (abc12345, code 0)"],
      opts: undefined,
      expected: ["no command output was found", "Reply HEARTBEAT_OK only"],
      unexpected: ["Please relay the command output to the user", "abc12345"],
    },
    {
      name: "reports metadata-only failed exec completions without asking for logs",
      events: ["Exec failed (abc12345, code 1)"],
      opts: undefined,
      expected: [
        "without captured stdout/stderr",
        "include the exit status or signal",
        "Do not ask the user to provide missing logs",
      ],
      unexpected: ["Please relay the command output to the user"],
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
    const prompt = buildExecEventPrompt([`Exec finished: ${"x".repeat(8_100)}`]);

    expect(prompt).toContain("[truncated]");
    expect(prompt.length).toBeLessThan(8_500);
  });

  it("uses heartbeat_respond for empty cron events in response-tool mode", () => {
    const prompt = buildCronEventPrompt([""], { useHeartbeatResponseTool: true });

    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });

  it("uses heartbeat_respond for quiet exec completion events in response-tool mode", () => {
    const prompt = buildExecEventPrompt([""], { useHeartbeatResponseTool: true });

    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });
});

describe("heartbeat event classification", () => {
  it.each([
    { value: "exec finished: ok", expected: true },
    { value: "Exec finished (node=abc, code 0)", expected: true },
    { value: "Exec Finished (node=abc, code 1)", expected: true },
    { value: "Exec completed (abc12345, code 0)", expected: true },
    { value: "Exec completed (abc12345, code 0) :: some output", expected: true },
    { value: "Exec failed (abc12345, code 1)", expected: true },
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
    { value: "Exec completed (abc12345, code 0)", expected: false },
    { value: "Exec completed (abc12345, code 0) :: some output", expected: false },
    { value: "Exec failed (abc12345, code 1)", expected: false },
    { value: "Exec failed (abc12345, signal SIGTERM) :: error output", expected: false },
    { value: "Exec completed (rotate api keys)", expected: true },
    { value: "Reminder: if exec failed, notify me", expected: true },
  ])("classifies cron system events for %j", ({ value, expected }) => {
    expect(isCronSystemEvent(value)).toBe(expected);
  });

  it.each([
    { value: "Exec completed (abc12345, code 0)", expected: false },
    { value: "Exec completed (abc12345, code 0) :: some output", expected: true },
    { value: "Exec failed (abc12345, code 1)", expected: true },
    { value: "Exec failed (abc12345, signal SIGTERM)", expected: true },
    { value: "exec finished: ok", expected: true },
  ])("classifies relayable exec completion events for %j", ({ value, expected }) => {
    expect(isRelayableExecCompletionEvent(value)).toBe(expected);
  });
});

describe("isSlackInteractionEvent", () => {
  it("returns true for Slack interaction events with slack:interaction contextKey", () => {
    expect(
      isSlackInteractionEvent({
        text: `Slack interaction: ${JSON.stringify({ actionId: "approve", value: "merge-99544" })}`,
        contextKey: "slack:interaction:C123:1234567890.123456:approve",
      }),
    ).toBe(true);
  });

  it("returns false for exec completion events even with slack:interaction contextKey", () => {
    expect(
      isSlackInteractionEvent({
        text: "Exec completed (abc123, code 0)",
        contextKey: "slack:interaction:C123:1234567890.123456:approve",
      }),
    ).toBe(false);
  });

  it("returns false for heartbeat noise events", () => {
    expect(
      isSlackInteractionEvent({
        text: "heartbeat poll",
        contextKey: "slack:interaction:C123:1234567890.123456:approve",
      }),
    ).toBe(false);
  });

  it("returns false for events missing the Slack interaction prefix", () => {
    expect(
      isSlackInteractionEvent({
        text: JSON.stringify({ type: "block_actions", actions: [{ action_id: "approve" }] }),
        contextKey: "slack:interaction:C123:1234567890.123456:approve",
      }),
    ).toBe(false);
  });

  it("returns false for non-Slack events", () => {
    expect(
      isSlackInteractionEvent({
        text: `Slack interaction: ${JSON.stringify({ actionId: "approve" })}`,
        contextKey: "cron:daily-reminder",
      }),
    ).toBe(false);
  });
});

describe("buildSlackInteractionEventPrompt", () => {
  it.each([
    {
      name: "builds user-facing prompt with action_id and value",
      events: [
        `Slack interaction: ${JSON.stringify({ actionId: "approve_pr", value: "merge-99544" })}`,
      ],
      opts: { deliverToUser: true, useHeartbeatResponseTool: false },
      expected: [
        "Slack interactive component(s) were used",
        '1. action_id="approve_pr"',
        'value="merge-99544"',
        "Please act on these interaction(s)",
        "Reply HEARTBEAT_OK",
      ],
    },
    {
      name: "builds internal-only prompt",
      events: [
        `Slack interaction: ${JSON.stringify({ actionId: "approve_pr", value: "merge-99544" })}`,
      ],
      opts: { deliverToUser: false, useHeartbeatResponseTool: false },
      expected: ["Handle the result internally", "heartbeat_ok"],
      unexpected: ["Reply HEARTBEAT_OK"],
    },
    {
      name: "uses heartbeat_respond instruction when response tool is enabled",
      events: [
        `Slack interaction: ${JSON.stringify({ actionId: "approve_pr", value: "merge-99544" })}`,
      ],
      opts: { deliverToUser: true, useHeartbeatResponseTool: true },
      expected: ["Use heartbeat_respond", "acknowledge the interaction(s)"],
    },
    {
      name: "renders select menu values and input values",
      events: [
        `Slack interaction: ${JSON.stringify({
          actionId: "choose_options",
          selectedValues: ["option-a", "option-b"],
          inputValue: "free-form text",
        })}`,
      ],
      opts: { deliverToUser: true, useHeartbeatResponseTool: false },
      expected: [
        'action_id="choose_options"',
        'selected=["option-a","option-b"]',
        'input="free-form text"',
      ],
    },
    {
      name: "renders multiple queued interactions and preserves render/consume symmetry",
      events: [
        `Slack interaction: ${JSON.stringify({ actionId: "approve_pr", value: "merge-99544" })}`,
        `Slack interaction: ${JSON.stringify({ actionId: "reject_pr", value: "close-99544" })}`,
      ],
      opts: { deliverToUser: true, useHeartbeatResponseTool: false },
      expected: [
        '1. action_id="approve_pr"',
        'value="merge-99544"',
        '2. action_id="reject_pr"',
        'value="close-99544"',
      ],
      unexpected: ["...and", "more Slack"],
    },
    {
      name: "caps at MAX_SLACK_INTERACTION_EVENTS and reports overflow",
      events: Array.from(
        { length: 6 },
        (_, index) =>
          `Slack interaction: ${JSON.stringify({ actionId: `action_${index}`, value: `value_${index}` })}`,
      ),
      opts: { deliverToUser: true, useHeartbeatResponseTool: false },
      expected: ["action_0", "action_4", "...and 1 more Slack interaction(s)"],
      unexpected: ["action_5"],
    },
  ])("$name", ({ events, opts, expected, unexpected }) => {
    const prompt = buildSlackInteractionEventPrompt(events, opts);
    for (const part of expected) {
      expect(prompt).toContain(part);
    }
    for (const part of unexpected ?? []) {
      expect(prompt).not.toContain(part);
    }
  });
});
