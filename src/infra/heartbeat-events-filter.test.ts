// Covers heartbeat event prompt filtering.
import { describe, expect, it } from "vitest";
import { appendExecTimeoutRetryGuidance } from "../agents/bash-tools.exec-output.js";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
  isRelayableExecCompletionEvent,
} from "./heartbeat-events-filter.js";

describe("heartbeat event prompts", () => {
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
      name: "makes exec follow-ups conditional on new user-relevant information",
      events: ["Exec finished (node=abc id=123, code 0)\nUploaded file"],
      opts: undefined,
      expected: [
        "Exec finished",
        "Uploaded file",
        "requested result not yet delivered",
        "continue any outstanding authorized work",
        "routine output, duplicate or superseded results",
        "failures already recovered from",
        "reply NO_REPLY only",
      ],
      unexpected: ["system messages above", "Please relay the command output", "[truncated]"],
    },
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
      name: "suppresses empty exec completion prompts",
      events: ["", "   "],
      opts: undefined,
      expected: ["no command output was found", "Reply NO_REPLY only"],
      unexpected: ["Please relay the command output to the user", "system messages above"],
    },
    {
      name: "suppresses metadata-only successful exec completions",
      events: ["Exec completed (abc12345, code 0)"],
      opts: undefined,
      expected: ["no command output was found", "Reply NO_REPLY only"],
      unexpected: ["Please relay the command output to the user", "abc12345"],
    },
    {
      name: "applies relevance guidance to failures without captured logs",
      events: ["Exec failed (abc12345, code 1)"],
      opts: undefined,
      expected: [
        "without captured stdout/stderr",
        "include the exit status or signal",
        "Do not ask the user to provide missing logs",
        "Notify the user only",
        "failures already recovered from",
        "reply NO_REPLY only",
      ],
      unexpected: ["Please relay the command output to the user"],
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
      ],
      unexpected: ["no command output was found"],
    },
    {
      name: "keeps timeout retry guidance after captured output",
      events: [
        appendExecTimeoutRetryGuidance(
          "Exec failed (abc12345, signal SIGTERM) :: partial output",
          "overall-timeout",
        ),
      ],
      opts: undefined,
      expected: ["partial output", "Verify the resulting state before retrying"],
      unexpected: ["without captured stdout/stderr"],
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
    { value: "Exec Finished (node=abc, code 1)", expected: true },
    { value: "Exec completed (rotate api keys)", expected: false },
    { value: "Exec failed: notify me if this happens", expected: false },
    {
      value: "Exec failed (abc12345, signal SIGTERM)\n\nRemind me to retry tomorrow.",
      expected: false,
    },
    {
      value:
        appendExecTimeoutRetryGuidance(
          "Exec failed (abc12345, signal SIGTERM)",
          "overall-timeout",
        ) + "\n\nRemind me to retry tomorrow.",
      expected: false,
    },
  ])("classifies exec completion events for %j", ({ value, expected }) => {
    expect(isExecCompletionEvent(value)).toBe(expected);
  });

  it.each([
    { value: "  Cron: rotate logs  ", expected: true },
    { value: "   ", expected: false },
    { value: "NO_REPLY", expected: false },
    { value: "no_reply: actual reminder", expected: true },
    { value: "HEARTBEAT_OK", expected: false },
    { value: "heartbeat_ok: already handled", expected: false },
    { value: "heartbeat poll: noop", expected: false },
    { value: "heartbeat wake: noop", expected: false },
    { value: "exec finished: ok", expected: false },
    { value: "Exec completed (abc12345, code 0)", expected: false },
    { value: "Exec completed (rotate api keys)", expected: true },
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

describe("isExecCompletionEvent", () => {
  it("matches maybeNotifyOnExit (backgrounded allowlisted commands) events", () => {
    // Word-based session slugs (createSessionSlug)
    expect(isExecCompletionEvent("Exec completed (amber-at, code 0) :: some output")).toBe(true);
    expect(isExecCompletionEvent("Exec completed (calm-del, code 0)")).toBe(true);
    expect(isExecCompletionEvent("Exec failed (brisk-no, code 1) :: error text")).toBe(true);
    expect(isExecCompletionEvent("Exec failed (fresh-ke, signal SIGTERM)")).toBe(true);
    // Hex-style IDs also accepted
    expect(isExecCompletionEvent("Exec completed (abc12345, code 0)")).toBe(true);
  });

  it.each(["overall-timeout", "no-output-timeout"] as const)(
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

  it("does not false-positive on free-form cron text containing exec phrases", () => {
    expect(isExecCompletionEvent("Nightly backup exec failed – see logs")).toBe(false);
    expect(isExecCompletionEvent("Cron: check if exec completed successfully")).toBe(false);
    expect(isExecCompletionEvent("exec killed the process manually")).toBe(false);
    expect(isExecCompletionEvent("Exec finished weekly backup checks")).toBe(false);
    // Parenthesized false positive from review feedback — must not match mid-string
    expect(isExecCompletionEvent("Nightly backup exec failed (see logs)")).toBe(false);
    expect(isExecCompletionEvent("Check: exec completed (last run was yesterday)")).toBe(false);
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
