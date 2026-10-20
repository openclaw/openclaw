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

const silent = "reply with exactly NO_REPLY as the entire final answer";
const continuation = "continue any outstanding authorized work";
const recovered = "failures already recovered from";
const missingLogs = "Do not ask the user to provide missing logs";
const relayOutput = "Please relay the command output to the user";
const reminder = "Cron: rotate logs";
const relayReminder = "Please relay this reminder to the user";
const internalReminder = "Handle this reminder internally";
const followup = [
  "requested result not yet delivered",
  continuation,
  "routine output, duplicate or superseded results",
  recovered,
  silent,
];
function checkPrompt(prompt: string, expected: string[], unexpected: string[]) {
  for (const part of expected) {
    expect(prompt).toContain(part);
  }
  for (const part of unexpected) {
    expect(prompt).not.toContain(part);
  }
}

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
    [
      "relay",
      [reminder],
      undefined,
      [reminder, relayReminder],
      [internalReminder, "Reply with exactly NO_REPLY"],
    ],
    ["internal", [reminder], false, [reminder, internalReminder], [relayReminder]],
    [
      "empty relay",
      ["", "   "],
      undefined,
      [
        "Reply with exactly NO_REPLY as the entire final answer.",
        "send confirmations before ending silently",
      ],
      [internalReminder],
    ],
    [
      "empty internal",
      ["", "   "],
      false,
      ["Handle this internally", "If nothing needs user-facing follow-up", silent],
      [relayReminder],
    ],
  ] satisfies Array<[string, string[], boolean | undefined, string[], string[]]>)(
    "builds %s cron prompt",
    (_name, events, deliverToUser, expected, unexpected) => {
      checkPrompt(buildCronEventPrompt(events, { deliverToUser }), expected, unexpected);
    },
  );

  it.each([
    {
      name: "makes exec follow-ups conditional on new user-relevant information",
      events: ["Exec finished (node=abc id=123, code 0)\nUploaded file"],
      expected: ["Exec finished", "Uploaded file", ...followup],
      unexpected: ["system messages above", "Please relay the command output", "[truncated]"],
    },
    {
      name: "builds internal-only exec prompt when delivery is disabled",
      events: ["Exec failed (node=abc id=123, code 1)\nUpload failed"],
      opts: { deliverToUser: false },
      expected: ["user delivery is disabled", "Handle the result internally", silent],
      unexpected: ["Upload failed", "system messages above", relayOutput],
    },
    {
      name: "keeps metadata-only successful exec completions as continuations",
      events: ["Exec completed (abc12345, code 0)"],
      expected: [
        "Exec completed (abc12345, code 0) without captured stdout/stderr.",
        continuation,
        missingLogs,
        silent,
      ],
      unexpected: [relayOutput],
    },
    {
      name: "applies relevance guidance to failures without captured logs",
      events: ["Exec failed (abc12345, code 1)"],
      expected: [
        "without captured stdout/stderr",
        "include the exit status or signal",
        missingLogs,
        "Notify the user only",
        recovered,
        silent,
      ],
      unexpected: [relayOutput],
    },
    {
      name: "keeps timeout retry guidance when the command printed nothing",
      events: [
        appendExecTimeoutRetryGuidance("Exec failed (abc12345, signal SIGTERM)", "overall-timeout"),
      ],
      expected: [
        "Exec failed (abc12345, signal SIGTERM) without captured stdout/stderr.",
        "Verify the resulting state before retrying",
        "include the exit status or signal",
        ...followup,
      ],
      unexpected: ["no command output was found"],
    },
  ])("$name", ({ events, opts, expected, unexpected }) => {
    checkPrompt(buildExecEventPrompt(events, opts), expected, unexpected);
  });

  it.each([
    "Exec completed (report-job, code 0) :: Report ready",
    "Exec failed (report-job, code 1)",
  ])("uses the response tool for a nonempty completion: %s", (event) => {
    checkPrompt(
      buildExecEventPrompt([event], { useHeartbeatResponseTool: true }),
      [
        "requested result not yet delivered",
        "heartbeat_respond",
        "notify=false",
        "notify=true with notificationText",
      ],
      ["reply with exactly NO_REPLY", "Please relay the command output"],
    );
  });

  it("uses heartbeat_respond for empty cron events in response-tool mode", () => {
    checkPrompt(
      buildCronEventPrompt([""], { useHeartbeatResponseTool: true }),
      ["heartbeat_respond", "notify=false"],
      ["HEARTBEAT_OK"],
    );
  });
});

describe("heartbeat event classification", () => {
  it.each([
    { value: "   ", expected: false },
    { value: "NO_REPLY", expected: true },
    { value: "no_r", expected: true },
    { value: "NO_R", expected: true },
    { value: "no_reply: actual reminder", expected: true },
    { value: "HEARTBEAT_OK", expected: false },
    { value: "heartbeat_ok: already handled", expected: false },
    { value: "Exec completed (abc12345, code 0)", expected: false },
  ])("classifies cron system events for %j", ({ value, expected }) => {
    expect(isCronSystemEvent({ text: value })).toBe(expected);
  });

  it("classifies legacy relayable exec completion events", () => {
    expect(isRelayableExecCompletionEvent("exec finished: ok")).toBe(true);
  });
});

describe("isExecCompletionEvent", () => {
  it("matches timeout completions that carry retry guidance without output", () => {
    const event = appendExecTimeoutRetryGuidance(
      "Exec failed (calm-del, signal SIGKILL)",
      "overall-timeout",
    );
    expect(isExecCompletionEvent(event)).toBe(true);
    expect(isRelayableExecCompletionEvent(event)).toBe(true);
  });
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
