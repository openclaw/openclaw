/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { mountCard } from "./chat-tool-cards.test-support.tsx";

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent;

it.each([
  [{ live: true }, "Checking goal"],
  [{ completed: true }, "Checked goal"],
  [{ completed: true, isError: true }, "Check goal"],
  [{}, "Check goal"],
] as const)(
  "describes a goal lookup without implying pursuit or completion: %j",
  async (state, label) => {
    const container = await mountCard(
      { id: "goal-lookup", name: "mcp__openclaw__get_goal", args: {}, ...state },
      { messageKey: "goal-lookup", expanded: false, runActive: true },
    );
    expect(text(container, ".chat-tool-row__title")).toBe(label);
  },
);

it.each([
  ["wait", { runId: "cm_test" }, "Wait"],
  ["ask_user", { questions: [{ question: "Do not repeat this prompt" }] }, "Asked you a question"],
  ["tool_call", { id: "openclaw:core:wait", args: { runId: "cm_test" } }, "Wait"],
  ["custom_tool", { text: "Inspect the workspace" }, "Custom Tool"],
  [
    "ToolSearch",
    { query: "select:mcp__openclaw__exec,mcp__openclaw__sessions_send" },
    "Selected tools",
  ],
  ["ToolSearch", { query: "find session tools" }, "Searched tools"],
  ["mcp__openclaw__tool_search", { query: "session tools" }, "Searched tools"],
  ["mcp__openclaw__sessions_list", { limit: 200 }, "Listed chats"],
  ["sessions_list", { search: "00000000-0000-4000-8000-000000007ef3" }, "Listed chats"],
] as const)(
  "keeps %s factual while retaining its input for inspection",
  async (name, args, label) => {
    const container = document.createElement("div");
    for (const expanded of [false, true]) {
      await mountCard(
        { id: "no-detail", name, args, inputText: JSON.stringify(args), completed: true },
        { messageKey: "no-detail", expanded },
        container,
      );
      expect(text(container, ".chat-tool-disclosure__content")?.trim()).toBe(label);
      if (expanded) {
        for (const field of ["text", "query", "search", "limit"] as const) {
          if (field in args) {
            expect(text(container, ".chat-tool-msg-body")).toContain(
              String(args[field as keyof typeof args]),
            );
          }
        }
      }
    }
  },
);

it.each([
  [
    "kill",
    { status: "completed", cancellationRequested: true, terminationConfirmed: false },
    "Requested process stop",
  ],
  ["clear", { status: "completed" }, "Removed finished process record"],
] as const)("describes what a completed process %s call did", async (action, details, label) => {
  const container = await mountCard(
    { id: action, name: "process", args: { action, sessionId: "job" }, completed: true, details },
    { expanded: false },
  );
  expect(text(container, ".chat-tool-row__title")).toBe(label);
});

it.each([
  { code: "await tools.read({ path: 'README.md' })" },
  { command: "set -euo pipefail\npnpm test" },
])("shows the recorded exec action and retains purpose in inspection: %j", async (args) => {
  const card = {
    id: "msg:purpose",
    name: "exec",
    args: { ...args, title: "Check the workspace" },
    live: true,
    outputText: "workspace checked",
  };
  const options = { messageKey: "purpose", expanded: false, runActive: true };
  const container = await mountCard(card, options);
  if (args.code) {
    expect(text(container, ".chat-tool-row__title")).toBe("Check the workspace");
    expect(container.querySelector(".chat-tool-row__cmd")).toBeNull();
  } else {
    expect(text(container, ".chat-tool-row__cmd")).toBe("pnpm test");
    expect(text(container, ".chat-tool-disclosure__content")).not.toContain("Check the workspace");
  }
  expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

  await mountCard({ ...card, completed: true }, { ...options, expanded: true }, container);
  expect(text(container, args.code ? ".chat-tool-row__title" : ".chat-tool-row__cmd")).toBe(
    args.code ? "Check the workspace" : "pnpm test",
  );
  expect(text(container, ".chat-tool-msg-body")).toContain("Check the workspace");
  for (const source of Object.values(args)) {
    expect(text(container, ".chat-tool-msg-body")).toContain(source);
  }
  if (args.code) {
    expect(container.querySelector(".chat-tool-term")).toBeNull();
  }
  expect(text(container, ".chat-tool-msg-body")).toContain("workspace checked");
});

it("does not treat business title arguments as activity descriptions", async () => {
  const container = await mountCard(
    {
      id: "business-title",
      name: "calendar_create",
      args: { title: "Team meeting", command: "create" },
    },
    { messageKey: "business-title", expanded: false },
  );
  expect(container.querySelector(".chat-tool-row__title")).toBeNull();
});

it.each([
  [
    "printf '\n--- recovery ---\n'\ncat recovery.md\n" + "echo example\n".repeat(100),
    "printf ' --- recovery --- ' cat recovery.md",
  ],
  [`printf ${"long argument ".repeat(25)}`, "printf long argument"],
])("keeps command previews bounded without changing the source: %s", async (command, prefix) => {
  const card = { id: "multiline-command", name: "exec", args: { command }, completed: true };
  const container = await mountCard(card, { messageKey: "multiline-command" });
  const preview = text(container, ".chat-tool-row__cmd") ?? "";
  expect(preview).toContain(prefix);
  expect(preview.length).toBeLessThanOrEqual(200);
  expect(container.querySelector(".chat-tool-term__cmd code")?.textContent).toBe(command);
});

it("uses names already available to chat rows without exposing unresolved routing keys", async () => {
  const key = "agent:main:subagent:00000000-0000-4000-8000-000000007ef3";
  const activeRunIds = ["run"];
  const session = { key, kind: "direct" as const, label: "Research", updatedAt: 1, activeRunIds };
  for (const [name, args, known, unresolved] of [
    ["sessions_history", { sessionKey: key }, "Read chat Research", "Read chat"],
    [
      "sessions_send",
      { sessionKey: key },
      "Delivery unconfirmed · Research",
      "Delivery unconfirmed",
    ],
    ["agents_wait", { ids: ["run"] }, "Waited for Research", "Waited for agents"],
  ] as const) {
    for (const [subagentSessions, expected] of [
      [[session], known],
      [[], unresolved],
      [[{ ...session, label: undefined }], unresolved],
    ] as const) {
      const container = await mountCard(
        { id: name, name, completed: true, args },
        { messageKey: name, subagents: { subagentSessions: [...subagentSessions] } },
      );
      expect(text(container, ".chat-tool-disclosure__content")).toBe(expected);
    }
  }
});

it.each([
  [undefined, "Delivery unconfirmed · Release review"],
  [{ status: "other" }, "Delivery unconfirmed · Release review"],
  [{ status: "accepted", targetDisposition: "queued" }, "Message accepted for Release review"],
  [{ status: "queued", runStarted: false }, "Queued message to Release review"],
  [
    { status: "started", retained: { acceptance: "not_accepted" } },
    "Message to Release review deferred",
  ],
  [{ status: "ok", reply: "Received" }, "Sent message to Release review"],
  [{ status: "no_reply" }, "Sent message to Release review"],
] as const)("does not equate a completed send call with delivery: %j", async (receipt, label) => {
  const args = { label: "Release review", message: "Please review the change" };
  const container = await mountCard(
    {
      id: "send",
      name: "mcp__openclaw__sessions_send",
      args,
      completed: true,
      outputText: receipt && JSON.stringify(receipt),
    },
    { expanded: false },
  );
  expect(text(container, ".chat-tool-disclosure__content")).toBe(label);
});

it.each([
  [
    { name: "ToolSearch", args: { query: "select:mcp__openclaw__exec" }, live: true },
    "Selecting tools",
  ],
  [{ name: "sessions_list", args: { limit: 200 }, isError: true }, "List chats"],
  [{ name: "sessions_send", args: { sessionKey: "unknown" }, live: true }, "Sending message"],
  [{ name: "sessions_send", isError: true, details: { status: "ok" } }, "Send message"],
  [
    {
      name: "sessions_send",
      args: { label: "Review" },
      isError: true,
      details: { status: "timeout", error: "agent run timed out", sentBeforeError: true },
    },
    "Sent to Review · reply timed out",
  ],
  [
    {
      name: "sessions_send",
      isError: true,
      outputText: JSON.stringify({
        status: "error",
        error: "Gateway admission is still pending; inspect this run before retrying.",
        sentBeforeError: true,
      }),
    },
    "Delivery unconfirmed",
  ],
  [{ name: "sessions_send", isError: true, details: { status: "timeout" } }, "Send message"],
  [
    {
      name: "tool_call",
      args: { id: "openclaw:core:sessions_send", args: { label: "Review", message: "Check this" } },
      completed: true,
      outputText: JSON.stringify({
        tool: { name: "sessions_send" },
        result: { content: [{ type: "text", text: JSON.stringify({ status: "accepted" }) }] },
      }),
    },
    "Message accepted for Review",
  ],
] as const)(
  "keeps the actual phase and receipt through display normalization: %j",
  async (card, label) => {
    const container = await mountCard(
      { id: "phase", ...card },
      { expanded: false, runActive: true },
    );
    expect(text(container, ".chat-tool-disclosure__content")).toBe(label);
  },
);

it.each([
  ["conversations_send", { details: { status: "sent" } }, "Sent to conversation"],
  ["conversations_send", { outputText: '{"status":"queued"}' }, "Message queued"],
  ["conversations_send", { details: { status: "suppressed" } }, "Message not sent"],
  ["conversations_send", { details: { status: "unknown" } }, "Delivery unconfirmed"],
  ["conversations_send", {}, "Delivery unconfirmed"],
  ["conversations_turn", { live: true, completed: false }, "Sending and waiting for a reply"],
  ["conversations_turn", { details: { status: "replied" } }, "Sent · reply received"],
  ["conversations_turn", { details: { status: "timeout" } }, "Sent · reply timed out"],
  [
    "conversations_turn",
    { details: { status: "sent", error: "No reply correlation" } },
    "Sent to conversation",
  ],
  ["conversations_turn", { details: { status: "queued" } }, "Message queued"],
] as const)(
  "shows the conversation delivery receipt for %s: %j",
  async (name, result, expected) => {
    const container = await mountCard(
      { id: "conversation", name, args: { message: "Hello" }, completed: true, ...result },
      { expanded: false, runActive: true },
    );
    expect(text(container, ".chat-tool-disclosure__content")).toBe(expected);
  },
);

const stop = (details: object, args: object = {}) => ({
  name: "sessions",
  args: { action: "stop", sessionKey: "agent:main:subagent:worker", runId: "run-secret", ...args },
  details: { ok: true, status: "aborted", abortedRunId: "run-secret", ...details },
});
const cancel = (status: string) => ({
  name: "subagents",
  args: { action: "cancel", runId: "run-secret" },
  details: { found: true, killed: true, targetState: { state: "terminal", task: { status } } },
});

it.each([
  [cancel("cancelled"), "Stopped"],
  [cancel("succeeded"), "Stop subagent"],
  [stop({}), "Stopped"],
  [stop({}, { runId: undefined }), "Stopped"],
  [stop({ status: "settling" }), "Stop subagent"],
  [stop({ abortedRunId: "different-run" }), "Stop subagent"],
  [{ ...stop({}), isError: true }, "Stop subagent"],
  [stop({}, { sessionKey: "agent:main:dashboard:ordinary" }), "Session Settings"],
])(
  "describes cancellation only when its own target receipt confirms it: %j",
  async (card, label) => {
    const { details, ...call } = card;
    for (const receipt of [{ details }, { outputText: JSON.stringify(details) }]) {
      const container = await mountCard(
        { id: "cancel", completed: true, ...call, ...receipt },
        { expanded: false },
      );
      expect(text(container, ".chat-tool-disclosure__content")?.trim()).toBe(label);
    }
  },
);
