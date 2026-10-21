import { expect, it } from "vitest";
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
const completed = "Exec completed (job, code 0)";
const failed = "Exec failed (job, code 1)";
const timeoutHead = "Exec failed (job, signal SIGTERM)";
const timeoutEvent = appendExecTimeoutRetryGuidance(timeoutHead, "overall-timeout");
const responseTool = { useHeartbeatResponseTool: true };
const toolFollowup = ["requested result not yet delivered", "notify=true with notificationText"];
const toolForbidden = ["reply with exactly NO_REPLY", "Please relay the command output"];
const completionEvent = {
  text: "Exec completed (command, code 0) :: result",
  contextKey: "exec:command",
  fromConversationTurn: true,
};
const followup = [
  "requested result not yet delivered",
  continuation,
  "routine output, duplicate or superseded results",
  recovered,
  silent,
];
function checkPrompt(prompt: string, expected: string[], unexpected: string[]) {
  expected.forEach((part) => expect(prompt).toContain(part));
  unexpected.forEach((part) => expect(prompt).not.toContain(part));
}

it.each([
  [completionEvent, true],
  [{ ...completionEvent, contextKey: "notice:ordinary" }, false],
  [{ ...completionEvent, fromConversationTurn: false }, false],
] as const)("keeps conversation completion bound to its producer: %j", (event, expected) => {
  expect(isConversationExecCompletion(event)).toBe(expected);
});

it.each([
  [
    [reminder],
    undefined,
    [reminder, relayReminder],
    [internalReminder, "Reply with exactly NO_REPLY"],
  ],
  [[reminder], false, [reminder, internalReminder], [relayReminder]],
  [
    ["", "   "],
    undefined,
    [
      "Reply with exactly NO_REPLY as the entire final answer.",
      "send confirmations before ending silently",
    ],
    [internalReminder],
  ],
  [
    ["", "   "],
    false,
    ["Handle this internally", "If nothing needs user-facing follow-up", silent],
    [relayReminder],
  ],
] satisfies Array<[string[], boolean | undefined, string[], string[]]>)(
  "builds cron prompt for %j with delivery %s",
  (events, deliverToUser, expected, unexpected) => {
    checkPrompt(buildCronEventPrompt(events, { deliverToUser }), expected, unexpected);
  },
);

it.each([
  [
    "Exec finished: Uploaded file",
    ["Exec finished", "Uploaded file", ...followup],
    ["system messages above", "Please relay the command output", "[truncated]"],
  ],
  [
    "Exec failed: Upload failed",
    ["user delivery is disabled", "Handle the result internally", silent],
    ["Upload failed", "system messages above", relayOutput],
    { deliverToUser: false },
  ],
  [
    completed,
    [`${completed} without captured stdout/stderr.`, continuation, missingLogs, silent],
    [relayOutput],
  ],
  [
    failed,
    [
      "without captured stdout/stderr",
      "include the exit status or signal",
      missingLogs,
      "Notify the user only",
      recovered,
      silent,
    ],
    [relayOutput],
  ],
  [
    timeoutEvent,
    [
      `${timeoutHead} without captured stdout/stderr.`,
      "Verify the resulting state before retrying",
      "include the exit status or signal",
      ...followup,
    ],
    ["no command output was found"],
  ],
] satisfies Array<[string, string[], string[], { deliverToUser: boolean }?]>)(
  "builds continuation prompt for %s",
  (event, expected, unexpected, opts?: Parameters<typeof buildExecEventPrompt>[1]) => {
    checkPrompt(buildExecEventPrompt([event], opts), expected, unexpected);
  },
);

it.each([
  [`${completed} :: Report ready`, "exec", toolFollowup, toolForbidden],
  [failed, "exec", toolFollowup, toolForbidden],
  ["", "cron", [], ["HEARTBEAT_OK"]],
] satisfies Array<[string, string, string[], string[]]>)(
  "uses the response tool for %s (%s)",
  (event, kind, expected, unexpected) => {
    const build = kind === "exec" ? buildExecEventPrompt : buildCronEventPrompt;
    checkPrompt(
      build([event], responseTool),
      ["heartbeat_respond", "notify=false", ...expected],
      unexpected,
    );
  },
);
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

it.each([
  "exec finished: ok",
  appendExecTimeoutRetryGuidance("Exec failed (calm-del, signal SIGKILL)", "overall-timeout"),
])("classifies relayable exec completion events: %s", (event) => {
  expect(isExecCompletionEvent(event)).toBe(true);
  expect(isRelayableExecCompletionEvent(event)).toBe(true);
});
it("does not split surrogate pairs in long event text", () => {
  const safePrefix = "x".repeat(7_999);
  const result = buildExecEventPrompt([`${safePrefix}🚀tail`]);

  expect(result).toContain(`${safePrefix}\n\n[truncated]`);
  expect(result).not.toContain("🚀tail");
  const promptOverhead = buildExecEventPrompt(["x"]).length - 1;
  expect(result.length).toBe(safePrefix.length + "\n\n[truncated]".length + promptOverhead);
});
