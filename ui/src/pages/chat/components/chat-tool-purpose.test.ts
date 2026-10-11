/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { renderToolCard } from "./chat-tool-cards.ts";
import { renderToolFixture as render } from "./chat-tool-render.test-support.ts";

describe("execution purpose cards", () => {
  it.each([
    { name: "wait", args: { runId: "cm_test" }, label: "Wait" },
    { name: "session_status", args: {}, label: "Session Status" },
    { name: "custom_tool", args: { text: "custom tool" }, label: "Custom Tool" },
    {
      name: "tool_call",
      args: { id: "openclaw:core:wait", args: { runId: "cm_test" } },
      label: "Wait",
    },
  ])("keeps $name readable without distinct detail text", async ({ name, args, label }) => {
    const container = document.createElement("div");
    for (const expanded of [false, true]) {
      await render(
        renderToolCard(
          { id: "no-detail", name, args, completed: true },
          { messageKey: "no-detail", expanded, onToggleExpanded: vi.fn() },
        ),
        container,
      );
      expect(container.querySelector(".chat-tool-disclosure__content")?.textContent?.trim()).toBe(
        label,
      );
    }
  });

  it("keeps the tool name icon-only when a distinct preview identifies the operation", async () => {
    const container = document.createElement("div");
    await render(
      renderToolCard(
        { id: "with-detail", name: "custom_tool", args: { text: "Inspect the workspace" } },
        { messageKey: "with-detail", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );
    expect(container.querySelector(".chat-tool-disclosure__content")?.textContent?.trim()).toBe(
      "Inspect the workspace",
    );
    expect(container.querySelector(".chat-tool-msg-summary__label")).toBeNull();
  });

  it.each([
    { name: "exec", args: { code: "await tools.read({ path: 'README.md' })" } },
    { name: "exec", args: { command: "set -euo pipefail\npnpm test" } },
    {
      name: "exec",
      args: { command: "pnpm test", code: "await tools.read({ path: 'README.md' })" },
    },
    { name: "bash", args: { command: "pnpm test" } },
    { name: "shell", args: { command: "pnpm test" } },
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
        onToggleExpanded: vi.fn(),
      };
      await render(renderToolCard(card, options), container);
      expect(container.querySelector(".chat-tool-row__title")?.textContent).toBe(
        "Check the workspace",
      );
      expect(container.querySelector(".chat-tool-row__cmd")).toBeNull();
      expect(container.querySelector(".chat-tool-msg-body")).toBeNull();

      await render(
        renderToolCard({ ...card, completed: true }, { ...options, expanded: true }),
        container,
      );
      expect(container.querySelector(".chat-tool-row__title")?.textContent).toBe(
        "Check the workspace",
      );
      for (const source of Object.values(args)) {
        expect(container.querySelector(".chat-tool-msg-body")?.textContent).toContain(source);
      }
      if (args.code) {
        expect(container.querySelector(".chat-tool-term")).toBeNull();
      }
      expect(container.querySelector(".chat-tool-msg-body")?.textContent).toContain(
        "workspace checked",
      );
    },
  );

  it.each([
    { name: "calendar_create", args: { title: "Team meeting", command: "create" } },
    { name: "document_create", args: { title: "Design notes", content: "Draft" } },
  ])(
    "does not treat $name business title arguments as activity descriptions",
    async ({ name, args }) => {
      const container = document.createElement("div");
      await render(
        renderToolCard(
          { id: "business-title", name, args },
          {
            messageKey: "business-title",
            expanded: false,
            onToggleExpanded: vi.fn(),
          },
        ),
        container,
      );
      expect(container.querySelector(".chat-tool-row__title")).toBeNull();
    },
  );

  it("previews the useful command after shell setup while retaining the full command", async () => {
    const container = document.createElement("div");
    const card = {
      id: "shell-preamble",
      name: "exec",
      args: { command: "set -euo pipefail\ncd /workspace\npnpm test" },
    };
    await render(
      renderToolCard(card, {
        messageKey: "shell-preamble",
        expanded: true,
        onToggleExpanded: vi.fn(),
      }),
      container,
    );
    expect(container.querySelector(".chat-tool-row__cmd")?.textContent).toBe("pnpm test");
    expect(container.querySelector(".chat-tool-msg-body")?.textContent).toContain(
      card.args.command,
    );
  });

  it("keeps multiline command previews readable and bounded without changing the source", async () => {
    const container = document.createElement("div");
    const command =
      "printf '\n--- recovery ---\n'\ncat recovery.md\n" + "echo example\n".repeat(100);
    const card = { id: "multiline-command", name: "exec", args: { command } };
    await render(
      renderToolCard(card, {
        messageKey: "multiline-command",
        expanded: true,
        onToggleExpanded: vi.fn(),
      }),
      container,
    );
    const preview = container.querySelector(".chat-tool-row__cmd")?.textContent ?? "";
    expect(preview).toContain("printf ' --- recovery --- ' cat recovery.md");
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(container.querySelector(".chat-tool-msg-body")?.textContent).toContain(command);
  });
});
