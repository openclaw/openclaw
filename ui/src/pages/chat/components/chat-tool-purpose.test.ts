/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { mountCard } from "./chat-tool-cards.test-support.tsx";

const text = (container: ParentNode, selector: string) =>
  container.querySelector(selector)?.textContent;

describe("execution purpose cards", () => {
  it.each([
    { name: "wait", args: { runId: "cm_test" }, label: "Wait" },
    { name: "custom_tool", args: { text: "custom tool" }, label: "Custom Tool" },
    {
      name: "tool_call",
      args: { id: "openclaw:core:wait", args: { runId: "cm_test" } },
      label: "Wait",
    },
  ])("keeps $name readable without distinct detail text", async ({ name, args, label }) => {
    const container = document.createElement("div");
    for (const expanded of [false, true]) {
      await mountCard(
        { id: "no-detail", name, args, completed: true },
        { messageKey: "no-detail", expanded },
        container,
      );
      expect(text(container, ".chat-tool-disclosure__content")?.trim()).toBe(label);
    }
  });

  it("keeps the tool name icon-only when a distinct preview identifies the operation", async () => {
    const container = await mountCard(
      { id: "with-detail", name: "custom_tool", args: { text: "Inspect the workspace" } },
      { messageKey: "with-detail", expanded: false },
    );
    expect(text(container, ".chat-tool-disclosure__content")?.trim()).toBe("Inspect the workspace");
    expect(container.querySelector(".chat-tool-msg-summary__label")).toBeNull();
  });

  it.each([
    { name: "exec", args: { code: "await tools.read({ path: 'README.md' })" } },
    { name: "exec", args: { command: "set -euo pipefail\npnpm test" } },
  ])(
    "shows the agent purpose immediately for $name and retains execution details",
    async ({ name, args }) => {
      const container = document.createElement("div");
      const card = {
        id: "msg:purpose",
        name,
        args: { ...args, title: "Check the workspace" },
        live: true,
        outputText: "workspace checked",
      };
      const options = {
        messageKey: "purpose",
        expanded: false,
        runActive: true,
      };
      await mountCard(card, options, container);
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
    },
  );

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
    const command =
      "printf '\n--- recovery ---\n'\ncat recovery.md\n" + "echo example\n".repeat(100);
    const card = { id: "multiline-command", name: "exec", args: { command } };
    const container = await mountCard(card, { messageKey: "multiline-command" });
    const preview = text(container, ".chat-tool-row__cmd") ?? "";
    expect(preview).toContain("printf ' --- recovery --- ' cat recovery.md");
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(text(container, ".chat-tool-msg-body")).toContain(command);
  });
});
