/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { mountCard } from "./chat-tool-cards.test-support.tsx";

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent;

it.each([
  ["wait", { runId: "cm_test" }, "Wait", false],
  ["custom_tool", { text: "custom tool" }, "Custom Tool", false],
  ["tool_call", { id: "openclaw:core:wait", args: { runId: "cm_test" } }, "Wait", false],
  ["custom_tool", { text: "Inspect the workspace" }, "Inspect the workspace", true],
] as const)(
  "keeps %s readable with the appropriate detail",
  async (name, args, label, distinct) => {
    const container = document.createElement("div");
    for (const expanded of [false, true]) {
      await mountCard(
        { id: "no-detail", name, args, completed: true },
        { messageKey: "no-detail", expanded },
        container,
      );
      expect(text(container, ".chat-tool-disclosure__content")?.trim()).toBe(label);
      if (distinct) {
        expect(container.querySelector(".chat-tool-msg-summary__label")).toBeNull();
      }
    }
  },
);

it.each([
  { code: "await tools.read({ path: 'README.md' })" },
  { command: "set -euo pipefail\npnpm test" },
])("shows the exec purpose immediately and retains execution details: %j", async (args) => {
  const card = {
    id: "msg:purpose",
    name: "exec",
    args: { ...args, title: "Check the workspace" },
    live: true,
    outputText: "workspace checked",
  };
  const options = { messageKey: "purpose", expanded: false, runActive: true };
  const container = await mountCard(card, options);
  expect(text(container, ".chat-tool-row__title")).toBe("Check the workspace");
  expect(container.querySelector(".chat-tool-row__cmd")).toBeNull();
  expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

  await mountCard({ ...card, completed: true }, { ...options, expanded: true }, container);
  expect(text(container, ".chat-tool-row__title")).toBe("Check the workspace");
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
