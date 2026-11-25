/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { jsonResult } from "../../../../../src/agents/tools/tool-results.js";
import { projectToolResultDetails } from "../../../../../src/gateway/chat-display-projection.canvas.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { mountCard } from "./chat-tool-cards.test-support.tsx";

const query = (root: ParentNode | null | undefined, selector: string) =>
  root?.querySelector<HTMLElement>(selector) ?? null;
const textOf = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent;
function mountTool(
  name: string,
  card: Partial<ToolCard>,
  options?: Parameters<typeof mountCard>[1],
  container?: Parameters<typeof mountCard>[2],
) {
  return mountCard({ id: name, name, ...card }, options, container);
}

it.each([
  [{ emoji: "👍" }, { completed: true }, "Reacted to message"],
  [{ emoji: "👍", remove: true }, { live: true }, "Removing reaction"],
  [{ emoji: "👍", remove: true }, { completed: true }, "Removed reaction"],
  [{ emoji: "👍", remove: true, dryRun: true }, { completed: true }, "Remove reaction"],
  [{ channel: "slack", emoji: "" }, { completed: true }, "Cleared reactions"],
  [{ channel: "feishu", messageId: "om_1", clearAll: true }, { live: true }, "Clearing reactions"],
  [
    { channel: "feishu", messageId: "om_1", clearAll: true, emoji: "THUMBSUP" },
    { completed: true, details: { ok: true, added: "THUMBSUP" } },
    "Reacted to message",
  ],
  [
    { channel: "feishu", emoji: "THUMBSUP", remove: true },
    { completed: true, isError: true, outputText: "Feishu reaction requires messageId." },
    "Remove reaction",
  ],
] as const)("labels the recorded message reaction: %j, %j", async (args, state, label) => {
  const container = await mountTool(
    "message",
    { args: { action: "react", ...args }, ...state },
    { expanded: false, runActive: true },
  );
  expect(textOf(container, ".chat-tool-row__title")).toBe(label);
  if ("isError" in state) {
    expect(textOf(container, ".chat-tool-msg-summary")?.toLowerCase()).toContain("failed");
  }
});

const webchatReaction = {
  channel: "webchat",
  messageId: "prompt-fixture",
  dryRun: false,
  reactions: [],
};
const slackClear = { channel: "slack", messageId: "123.456", emoji: "" };
const feishuClear = { channel: "feishu", messageId: "om_1", clearAll: true };
const feishuRemove = { channel: "feishu", messageId: "om_1", emoji: "THUMBSUP", remove: true };
it.each([
  [
    "duplicate WebChat addition",
    { emoji: "👍" },
    {
      ...webchatReaction,
      changed: false,
      remove: false,
      reactions: [{ emoji: "👍", count: 1, identities: [{ id: "agent:fixture" }] }],
    },
    "Reaction already present",
  ],
  [
    "absent WebChat reaction",
    { emoji: "👍", remove: true },
    { ...webchatReaction, changed: false, remove: true },
    "No reaction removed",
  ],
  [
    "actual WebChat removal",
    { emoji: "👍", remove: true },
    { ...webchatReaction, changed: true, remove: true },
    "Removed reaction",
  ],
  [
    "WebChat dry run",
    { emoji: "👍", remove: true, dryRun: true },
    { ...webchatReaction, changed: false, remove: true, dryRun: true },
    "Remove reaction",
  ],
  ["empty Slack clear", slackClear, { removed: [] }, "No reactions cleared"],
  ["Slack clear with a match", slackClear, { removed: ["thumbsup"] }, "Cleared reactions"],
  ["empty Feishu clear", feishuClear, { removed: 0 }, "No reactions cleared"],
  ["Feishu clear without an emoji", feishuClear, { removed: 2 }, "Cleared reactions"],
  ["absent Feishu reaction", feishuRemove, { removed: null }, "No reaction removed"],
  ["matching Feishu reaction", feishuRemove, { removed: "THUMBSUP" }, "Removed reaction"],
] as const)(
  "renders the recorded %s in collapsed reaction rows",
  async (_case, params, facts, label) => {
    const args = { action: "react", ...params };
    const direct = jsonResult({ ok: true, ...facts });
    const tool = { id: "message", name: "message", source: "openclaw" };
    const dispatch = jsonResult({ tool, result: { content: direct.content } });
    for (const [name, input, result, rawDetails] of [
      ["message", args, direct, direct.details],
      ["tool_call", { id: "message", args }, dispatch, { tool, result: direct }],
    ] as const) {
      const details = projectToolResultDetails(rawDetails, 4_096, { name }).details;
      const [card] = extractToolCardsCached({
        role: "assistant",
        content: [
          { type: "toolcall", id: "reaction", name, arguments: input },
          { type: "toolresult", id: "reaction", name, content: result.content, details },
        ],
      });
      const container = await mountCard(card!, { expanded: false });
      expect(textOf(container, ".chat-tool-row__title")).toBe(label);
    }
  },
);

it.each(["structured", "serialized"])("keeps %s captions out of collapsed rows", async (shape) => {
  const privateCaption =
    "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nPrivate synthetic caption.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
  const args = { action: "send", to: "fixture-room", message: privateCaption };
  const card = {
    id: "message-caption",
    name: "message",
    args: shape === "structured" ? args : JSON.stringify(args),
    inputText: JSON.stringify(args),
  };
  const options = { messageKey: "test-message", onToggleExpanded: vi.fn() };
  const container = await mountCard(card, { ...options, expanded: false });

  const summary = query(container, "button.chat-tool-msg-summary");
  expect(textOf(summary!, ".chat-tool-row__title")).toBe(
    shape === "structured" ? "Send message" : "Message",
  );
  expect(textOf(summary!, ".chat-activity-group__outcome") ?? null).toBe(
    shape === "structured" ? "No result recorded" : null,
  );
  expect(summary?.textContent).not.toContain("fixture-room");
  expect(query(summary, ".chat-tool-msg-summary__icon")?.getAttribute("aria-label")).toBe(
    "message",
  );
  expect(summary?.textContent).not.toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
  expect(container.textContent).not.toContain("Private synthetic caption.");
  expect(query(container, ".chat-tool-msg-body")).toBeNull();

  await mountCard(card, { ...options }, container);
  const diagnostics = query(container, ".chat-tool-msg-body");
  expect(diagnostics?.textContent).toContain("fixture-room");
  expect(diagnostics?.textContent).toContain("BEGIN_OPENCLAW_INTERNAL_CONTEXT");
  expect(diagnostics?.textContent).toContain("Private synthetic caption.");
});
