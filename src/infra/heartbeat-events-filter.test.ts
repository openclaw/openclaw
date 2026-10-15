// Covers heartbeat event prompt filtering.
import { describe, expect, it } from "vitest";
import { appendExecTimeoutRetryGuidance } from "../agents/bash-tools.exec-output.js";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isConversationExecCompletion,
  isCronSystemEvent,
  isExecCompletionEvent,
  isRelayableExecCompletionEvent,
} from "./heartbeat-events-filter.js";

describe("heartbeat event prompts", () => {
  it.each([
    { contextKey: "exec:command", fromConversationTurn: true, expected: true },
    { contextKey: "notice:ordinary", fromConversationTurn: true, expected: false },
    { contextKey: "exec:command", fromConversationTurn: false, expected: false },
  ])(
    "keeps conversation completion bound to its producer: $contextKey/$fromConversationTurn",
    ({ contextKey, fromConversationTurn, expected }) => {
      expect(
        isConversationExecCompletion({
          text: "Exec completed (command, code 0) :: result",
          contextKey,
          fromConversationTurn,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    {
      name: "builds user-relay cron prompt by default",
      events: ["Cron: rotate logs"],
      expected: ["Cron: rotate logs", "Please relay this reminder to the user"],
      unexpected: ["Handle this reminder internally", "Reply NO_REPLY."],
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
      expected: ["Reply NO_REPLY."],
      unexpected: ["Handle this reminder internally"],
    },
    {
      name: "uses internal empty-content fallback when delivery is disabled",
      events: ["", "   "],
      opts: { deliverToUser: false },
      expected: ["Handle this internally", "NO_REPLY when nothing needs user-facing follow-up"],
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
      name: "builds internal-only exec prompt when delivery is disabled",
      events: ["Exec failed (node=abc id=123, code 1)\nUpload failed"],
      opts: { deliverToUser: false },
      expected: ["user delivery is disabled", "Handle the result internally", "NO_REPLY only"],
      unexpected: [
        "Upload failed",
        "system messages above",
        "Please relay the command output to the user",
      ],
    },
    {
      name: "keeps timeout retry guidance when the command printed nothing",
      events: [
        appendExecTimeoutRetryGuidance("Exec failed (abc12345, signal SIGTERM)", "overall-timeout"),
      ],
      opts: undefined,
      expected: [
        "Exec failed (abc12345, signal SIGTERM) without captured stdout/stderr.",
        "Verify the resulting state before retrying",
        "include the exit status or signal",
        "requested result not yet delivered",
        "continue any outstanding authorized work",
        "routine output, duplicate or superseded results",
        "failures already recovered from",
        "reply NO_REPLY only",
      ],
      unexpected: ["no command output was found"],
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

  it.each([
    "Exec completed (report-job, code 0) :: Report ready",
    "Exec failed (report-job, code 1)",
  ])("uses the response tool for a nonempty completion: %s", (event) => {
    const prompt = buildExecEventPrompt([event], { useHeartbeatResponseTool: true });

    expect(prompt).toContain("requested result not yet delivered");
    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).toContain("notify=true with notificationText");
    expect(prompt).not.toContain("reply NO_REPLY only");
    expect(prompt).not.toContain("Please relay the command output");
  });

  it("uses heartbeat_respond for empty cron events in response-tool mode", () => {
    const prompt = buildCronEventPrompt([""], { useHeartbeatResponseTool: true });

    expect(prompt).toContain("heartbeat_respond");
    expect(prompt).toContain("notify=false");
    expect(prompt).not.toContain("HEARTBEAT_OK");
  });
});

describe("heartbeat event classification", () => {
  it.each([
    { value: "   ", expected: false },
    { value: "heartbeat_ok: already handled", expected: false },
    { value: "Exec completed (abc12345, code 0)", expected: false },
  ])("classifies cron system events for %j", ({ value, expected }) => {
    expect(isCronSystemEvent({ text: value })).toBe(expected);
  });

  it.each([{ value: "exec finished: ok", expected: true }])(
    "classifies relayable exec completion events for %j",
    ({ value, expected }) => {
      expect(isRelayableExecCompletionEvent(value)).toBe(expected);
    },
  );
});

describe("isExecCompletionEvent", () => {
  it.each(["overall-timeout"] as const)(
    "matches %s completions that carry retry guidance without output",
    (reason) => {
      const event = appendExecTimeoutRetryGuidance(
        "Exec failed (calm-del, signal SIGKILL)",
        reason,
      );
      expect(isExecCompletionEvent(event)).toBe(true);
      expect(isRelayableExecCompletionEvent(event)).toBe(true);
    },
  );
});

describe("buildExecEventPrompt truncation", () => {
  it("does not split surrogate pairs in long event text", () => {
    const safePrefix = "x".repeat(7_999);
    const result = buildExecEventPrompt([`${safePrefix}🚀tail`]);

    expect(result).toContain(`${safePrefix}\n\n[truncated]`);
    expect(result).not.toContain("🚀tail");
    const promptOverhead = buildExecEventPrompt(["x"]).length - 1;
    expect(result.length).toBe(safePrefix.length + "\n\n[truncated]".length + promptOverhead);
  });
});
