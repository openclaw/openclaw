/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { projectAgentActivityItem } from "../../../../../src/agents/agent-activity-presentation.js";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { attachHistoryActivity } from "../chat-history-request.ts";
import { agentEvent, createHost } from "../tool-stream.test-helpers.ts";
import { handleAgentEvent } from "../tool-stream.ts";
import { createMessageEntry, createToolGroup } from "./chat-message.test-support.ts";
import { renderActivityGroup } from "./chat-message.ts";
import { renderToolCard } from "./chat-tool-cards.ts";

// Outcome presentation for tool cards: neutral collapsed rows, the expanded
// outcome line, and the compact progress_card receipt.
describe("tool-card outcomes", () => {
  it.each([
    { status: "failed", label: "failed" },
    { status: "blocked", label: "Blocked" },
    { status: undefined, label: "Outcome unknown" },
    { status: "completed", label: "Completed" },
  ] as const)(
    "preserves prepared $status outcomes through live items and history attachment",
    ({ status, label }) => {
      const item = projectAgentActivityItem({
        itemId: "collaboration-call",
        toolCallId: "collaboration-call",
        kind: "tool",
        name: "subagents",
        title: "Delegate task",
        phase: "end",
        ...(status ? { status } : { summary: "Outcome unknown" }),
      } satisfies AgentActivityItem);
      const host = createHost({ chatRunId: "run-outcome" });
      handleAgentEvent(host, agentEvent("run-outcome", 1, "item", item));
      const live = host.chatToolMessages[0];
      const saved = {
        role: "assistant",
        messageId: "stored-call",
        content: [
          {
            type: "toolCall",
            id: "collaboration-call",
            name: "subagents",
            arguments: { task: "Check the report" },
          },
        ],
      };
      const history = attachHistoryActivity({
        messages: [saved],
        activity: [{ messageId: "stored-call", items: [item] }],
      });
      const container = document.createElement("div");
      for (const [message, runActive] of [
        [live, true],
        [history.messages[0], false],
      ] as const) {
        const group = createToolGroup("outcome", [createMessageEntry("call", message)]);
        render(renderActivityGroup([group], { showReasoning: false, runActive }), container);
        expect(container.querySelectorAll(".chat-tool-failure")).toHaveLength(
          status === "failed" ? 1 : 0,
        );
        render(
          renderActivityGroup([group], {
            showReasoning: false,
            runActive,
            isToolMessageExpanded: () => true,
            isToolExpanded: () => true,
          }),
          container,
        );
        expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe(label);
        expect(container.querySelector(".chat-tool-row--running")).toBeNull();
        const card = extractToolCardsCached(message)[0]!;
        expect(card.outputText).toBeUndefined();
        expect(card.isError).toBeUndefined();
        expect(card.completed).not.toBe(true);
      }
      expect(live).toMatchObject({ __openclawToolStreamResultReceived: false });
      expect(saved).not.toHaveProperty("activity");
    },
  );

  it("keeps a prepared nonzero exit failed without rewriting the raw tool result", () => {
    const host = createHost({ chatRunId: "command-run" });
    const args = { command: "check-report" };
    const result = {
      content: [{ type: "text", text: "Validation report" }],
      details: { status: "completed", exitCode: 2 },
    };
    handleAgentEvent(
      host,
      agentEvent("command-run", 1, "tool", {
        phase: "start",
        toolCallId: "check",
        name: "exec",
        args,
      }),
    );
    handleAgentEvent(
      host,
      agentEvent("command-run", 2, "tool", {
        phase: "result",
        toolCallId: "check",
        name: "exec",
        isError: false,
        result,
      }),
    );
    handleAgentEvent(
      host,
      agentEvent(
        "command-run",
        3,
        "item",
        projectAgentToolActivity({
          phase: "result",
          toolCallId: "check",
          name: "exec",
          isError: false,
          args,
          result,
        }),
      ),
    );
    const card = extractToolCardsCached(host.chatToolMessages[0])[0]!;
    expect(card).toMatchObject({
      isError: false,
      completed: true,
      outputText: "Validation report",
      details: result.details,
    });
    const container = document.createElement("div");
    render(
      renderToolCard(card, {
        messageKey: "result",
        expanded: true,
        runActive: true,
        onToggleExpanded: vi.fn(),
      }),
      container,
    );
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("Exit code 2");
    expect(container.querySelector(".chat-tool-row--running")).toBeNull();
    expect(container.textContent).toContain("Validation report");
    expect(container.textContent).toContain("check-report");
  });

  it.each([
    { name: "exec", args: { command: "pnpm check" } },
    { name: "write", args: { path: "/workspace/operation.json", content: "{}" } },
    { name: "lookup", args: { query: "release status" } },
    { name: "progress_card", args: { markdown: "Preparing release" } },
  ])("shows skipped $name calls without claiming failure or success", ({ name, args }) => {
    const container = document.createElement("div");
    const card: ToolCard = {
      id: "steering-skip",
      name,
      args,
      outputText: "Skipped to process an incoming message.",
      details: { status: "skipped", deniedReason: "steering" },
      isError: true,
      completed: true,
    };
    for (const expanded of [false, true]) {
      render(
        renderToolCard(card, {
          messageKey: "test-message",
          expanded,
          onToggleExpanded: vi.fn(),
        }),
        container,
      );
      expect(container.textContent?.toLowerCase()).toContain("skipped");
      expect(container.textContent).not.toMatch(/failed|Completed|updated|Tool error/);
      expect(container.querySelector(".chat-tool-card--error")).toBeNull();
    }
  });

  it.each(["exec", "lookup"])(
    "keeps %s progress neutral across the row, expanded body, and sidebar until completion",
    (name) => {
      const container = document.createElement("div");
      const onOpenSidebar = vi.fn();
      const card: ToolCard = {
        id: "progress",
        name,
        args: { command: "diagnostic" },
        outputText: '{"error":"progress sample"}',
        live: true,
        completed: false,
      };
      const show = () =>
        render(
          renderToolCard(card, {
            messageKey: "test-message",
            expanded: true,
            onToggleExpanded: vi.fn(),
            runActive: true,
            onOpenSidebar,
          }),
          container,
        );
      show();
      expect(container.querySelector(".chat-tool-row--running")).not.toBeNull();
      expect(container.querySelector(".chat-tool-card--error")).toBeNull();
      expect(container.querySelector(".chat-tool-failure")).toBeNull();
      expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("Running");
      expect(container.textContent).toContain(card.outputText);
      container.querySelector<HTMLButtonElement>(".chat-tool-card__action-btn")?.click();
      expect(onOpenSidebar).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("### Tool output") }),
      );
      expect(onOpenSidebar.mock.calls[0]?.[0].content).not.toContain("### Tool error");

      card.completed = true;
      card.isError = false;
      show();
      expect(container.querySelector(".chat-tool-row--running")).toBeNull();
      expect(container.querySelector(".chat-tool-card--error")).toBeNull();
      expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("Completed");
      card.isError = true;
      show();
      expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
      expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
    },
  );

  it("renders error details with the failure outcome in the expanded body", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:1",
          name: "web_search",
          args: { query: "python stable version" },
          inputText: '{\n  "query": "python stable version"\n}',
          outputText: JSON.stringify({
            error: "missing_brave_api_key",
            message: "BRAVE_API_KEY is not configured",
          }),
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Web Search",
    );
    const expandedCard = container.querySelector(".chat-tool-card");
    expect(expandedCard?.classList.contains("chat-tool-card--error")).toBe(true);
    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
    expect(
      Array.from(container.querySelectorAll(".chat-tool-card__block-label")).map(
        (label) => label.textContent,
      ),
    ).toContain("Tool error");
  });

  it("renders a neutral summary for a status-only error payload", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:status-only",
          name: "sessions_spawn",
          outputText: JSON.stringify({ status: "error" }),
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summary = container.querySelector(".chat-tool-msg-summary");
    expect(summary?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Sub-agent");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
  });

  it("renders a neutral summary when output is the literal 'Tool not found'", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:2",
          name: "Unknown",
          outputText: "Tool not found",
        },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summaryButton = container.querySelector("button.chat-tool-msg-summary");
    expect(summaryButton?.classList.contains("chat-tool-msg-summary--error")).toBe(false);
    expect(summaryButton?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe(
      "Unknown",
    );
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    expect(summaryButton?.textContent).toContain("failed");
    expect(container.textContent).not.toContain("Tool not found");
  });

  it.each([
    {
      name: "structured",
      output: JSON.stringify({ error: "Cannot connect to the service" }),
      diagnostic: "Cannot connect to the service",
      exitCode: 1,
      outcome: "Exit code 1",
    },
    {
      name: "multiline",
      output: "gh: command not found\nVerbose process diagnostics",
      diagnostic: "gh: command not found",
      exitCode: undefined,
      outcome: "failed",
    },
    {
      name: "long path",
      output:
        "Error: Could not find edits[1] in /workspace/dashboard-state-persistence-and-defaults/ui/src/e2e/dashboard-presentation-defaults.e2e.test.ts",
      diagnostic: "Could not find edits[1]",
      exitCode: undefined,
      outcome: "failed",
    },
  ])(
    "keeps $name diagnostics inside expanded tool details",
    ({ output, diagnostic, exitCode, outcome }) => {
      const container = document.createElement("div");
      let expanded = false;
      const show = () =>
        render(
          renderToolCard(
            {
              id: "login-failure",
              name: "exec",
              isError: true,
              completed: true,
              args: { title: "Sign in to GitHub", command: "gh auth login" },
              outputText: output,
              exitCode,
            },
            {
              messageKey: "login",
              expanded,
              onToggleExpanded: () => {
                expanded = !expanded;
                show();
              },
            },
          ),
          container,
        );
      show();
      expect(container.textContent).toContain("Sign in to GitHub");
      expect(container.textContent).not.toContain(diagnostic);
      expect(container.querySelector(".chat-tool-msg-summary")?.textContent).toContain(outcome);
      expect(container.textContent).not.toContain(output);
      expect(container.textContent).not.toContain("gh auth login");
      expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
      container.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")?.click();
      expect(container.querySelector(".chat-tool-msg-body")?.textContent).toContain(output);
      expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe(outcome);
      container.querySelector<HTMLButtonElement>(".chat-tool-msg-summary")?.click();
      expect(container.textContent).not.toContain(diagnostic);
    },
  );

  it("renders a neutral summary when the tool card has an explicit error flag", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:explicit",
          name: "lookup",
          outputText: "lookup failed",
          isError: true,
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    const summary = container.querySelector(".chat-tool-msg-summary");
    expect(summary?.querySelector(".chat-tool-msg-summary__label")?.textContent).toBe("Lookup");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-card--error")).not.toBeNull();
    expect(container.querySelector(".chat-tool-card__outcome")?.textContent).toBe("failed");
  });

  it("renders a plain error detail when a failed tool has no output", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:no-output",
          name: "lookup",
          isError: true,
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
    expect(container.querySelector(".chat-tool-card__block-label")?.textContent).toBe("Tool error");
    expect(container.querySelector(".chat-tool-card__block-content")?.textContent).toBe(
      "No output — tool failed.",
    );
  });

  it("respects an explicit success flag even when the payload looks like an error", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:err:status-false",
          name: "web_search",
          outputText: JSON.stringify({
            error: "missing_brave_api_key",
          }),
          isError: false,
        },
        { messageKey: "test-message", expanded: false, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Web Search");
    expect(container.textContent).not.toContain("Tool error");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-summary__error-badge")).toBeNull();
  });

  it("renders successful output without redundant Tool output labelling", () => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: "msg:ok:1",
          name: "browser.open",
          outputText: "Opened page",
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent).toContain("Opened page");
    expect(container.textContent).not.toContain("Tool output");
    expect(container.textContent).not.toContain("Tool error");
    expect(container.querySelector(".chat-tool-msg-summary--error")).toBeNull();
    expect(container.querySelector(".chat-tool-card__status-badge")).toBeNull();
  });

  it.each([
    {
      args: {
        markdown: "Implementation is moving.",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "in_progress" },
          { step: "Verify", status: "pending" },
        ],
      },
      expected: "Progress updated — 1/3 · Implement",
    },
    { args: { markdown: "Waiting on review." }, expected: "Progress note updated" },
  ])("renders progress_card as a compact receipt: $expected", ({ args, expected }) => {
    const container = document.createElement("div");
    render(
      renderToolCard(
        {
          id: `progress:${expected}`,
          name: "progress_card",
          args,
          outputText: "Progress card updated",
          completed: true,
        },
        { messageKey: "test-message", expanded: true, onToggleExpanded: vi.fn() },
      ),
      container,
    );

    expect(container.textContent?.trim()).toBe(expected);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    expect(container.textContent).not.toContain("Waiting on review.");
  });
});
