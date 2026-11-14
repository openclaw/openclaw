/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { mountCard } from "./chat-tool-cards.test-support.tsx";

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent;

it.each([
  ["wait", { runId: "cm_test" }, "Wait"],
  ["custom_tool", { text: "custom tool" }, "Custom Tool"],
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
    expect(text(container, ".chat-tool-disclosure__content")).toContain("Running");
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

it("keeps multiline command previews readable and bounded without changing the source", async () => {
  const command = "printf '\n--- recovery ---\n'\ncat recovery.md\n" + "echo example\n".repeat(100);
  const card = { id: "multiline-command", name: "exec", args: { command } };
  const container = await mountCard(card, { messageKey: "multiline-command" });
  const preview = text(container, ".chat-tool-row__cmd") ?? "";
  expect(preview).toContain("printf ' --- recovery --- ' cat recovery.md");
  expect(preview.length).toBeLessThanOrEqual(200);
  expect(text(container, ".chat-tool-msg-body")).toContain(command);
});

it("uses names already available to chat rows without exposing unresolved routing keys", async () => {
  const key = "agent:main:subagent:00000000-0000-4000-8000-000000007ef3";
  for (const name of ["sessions_history", "agents_wait"]) {
    const card = {
      id: name,
      name,
      completed: true,
      args: name === "sessions_history" ? { sessionKey: key } : { ids: ["known-run"] },
    };
    const container = await mountCard(card, {
      messageKey: name,
      subagents: {
        subagentSessions: [
          {
            key,
            kind: "direct",
            label: "Research",
            updatedAt: 1,
            activeRunIds: ["known-run"],
          },
        ],
      },
    });
    const expected = name === "sessions_history" ? "Read chat" : "Waited for";
    expect(text(container, ".chat-tool-disclosure__content")).toBe(expected + " Research");
    await mountCard(card, { messageKey: name, subagents: { subagentSessions: [] } }, container);
    expect(text(container, ".chat-tool-disclosure__content")).toBe(
      name === "sessions_history" ? expected : "Waited for agents",
    );
  }
});
