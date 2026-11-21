/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { mountCard } from "./chat-tool-cards.test-support.tsx";

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent;

it.each([
  ["wait", { runId: "cm_test" }, "Wait"],
  ["ask_user", { questions: [{ question: "Do not repeat this prompt" }] }, "Asked you a question"],
  ["tool_call", { id: "openclaw:core:wait", args: { runId: "cm_test" } }, "Wait"],
  ["custom_tool", { text: "Inspect the workspace" }, "Custom Tool"],
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
      if (expanded && "text" in args) {
        expect(text(container, ".chat-tool-msg-body")).toContain(args.text);
      }
    }
  },
);

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
    ["agents_wait", { ids: ["run"] }, "Waited for Research", "Waited for agents"],
  ] as const) {
    for (const [subagentSessions, expected] of [
      [[session], known],
      [[], unresolved],
    ] as const) {
      const container = await mountCard(
        { id: name, name, completed: true, args },
        { messageKey: name, subagents: { subagentSessions: [...subagentSessions] } },
      );
      expect(text(container, ".chat-tool-disclosure__content")).toBe(expected);
    }
  }
});

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
