import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveChatSubagentWait } from "./chat-subagent-wait.ts";
import { renderChatWorkingIndicator } from "./components/chat-working-indicator.ts";

const parent: GatewaySessionRow = {
  key: "agent:main:parent",
  kind: "direct",
  hasActiveRun: false,
  hasActiveSubagentRun: true,
  startedAt: 1_000,
};
const child: GatewaySessionRow = {
  key: "agent:main:subagent:child",
  kind: "direct",
  spawnedBy: parent.key,
  label: "Backend implementation",
  hasActiveRun: true,
};
const messages = [
  {
    role: "assistant",
    timestamp: 2_000,
    content: [{ type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} }],
  },
  {
    role: "toolResult",
    toolCallId: "yield",
    toolName: "sessions_yield",
    timestamp: 2_001,
    content: [{ type: "text", text: '{"status":"yielded"}' }],
  },
];

describe("chat waiting on subagents", () => {
  it.each([
    {
      name: "idle parent with active descendants",
      session: parent,
      ownRunActive: false,
      waiting: true,
    },
    { name: "new local parent run", session: parent, ownRunActive: true, waiting: false },
    {
      name: "own run reported by the row",
      session: { ...parent, hasActiveRun: true },
      ownRunActive: false,
      waiting: false,
    },
    {
      name: "settled descendants despite a stale child row",
      session: { ...parent, hasActiveSubagentRun: false },
      ownRunActive: false,
      waiting: false,
    },
    {
      name: "yielded parent remains running without its own run",
      session: { ...parent, status: "running" as const, activeRunIds: [] },
      ownRunActive: false,
      waiting: true,
    },
  ])("$name", ({ session, ownRunActive, waiting }) => {
    const result = resolveChatSubagentWait({
      selectedSession: session,
      runActive: ownRunActive,
      messages,
      subagentSessions: [child],
    });
    expect(result !== null).toBe(waiting);
    if (waiting) {
      expect(result).toEqual({ startedAt: 2_000, child: { key: child.key, label: child.label } });
    }
  });

  it("does not need child rows and only links a sole active direct child", () => {
    const derive = (childRows?: GatewaySessionRow[]) =>
      resolveChatSubagentWait({
        selectedSession: parent,
        runActive: false,
        messages,
        subagentSessions: childRows,
      });
    expect(derive()).toEqual({ startedAt: 2_000 });
    expect(derive([child, { ...child, key: "agent:main:subagent:other" }])?.child).toBeUndefined();
    expect(derive([{ ...child, spawnedBy: "agent:main:other" }])?.child).toBeUndefined();
    expect(derive([{ ...child, hasActiveRun: false }])?.child).toBeUndefined();
    expect(
      derive([child, { ...child, key: "agent:main:grandchild", spawnedBy: child.key }])?.child?.key,
    ).toBe(child.key);
  });

  it.each([
    { name: "no delivered yield", history: [], startedAt: 1_000 },
    { name: "unknown own run start", history: messages, startedAt: undefined },
    { name: "yield predates latest own run", history: messages, startedAt: 3_000 },
  ])("omits elapsed time with $name", ({ history, startedAt }) => {
    expect(
      resolveChatSubagentWait({
        selectedSession: { ...parent, startedAt },
        runActive: false,
        messages: history,
      }),
    ).toEqual({ startedAt: null });
  });

  it("renders the wait without parent output usage or rotating phrases and navigates the child", () => {
    const container = document.createElement("div");
    const onOpenSession = vi.fn();
    const waitingSubagents = { startedAt: 2_000, child: { key: child.key, label: child.label! } };
    const draw = (startedAt: number | null) =>
      render(
        renderChatWorkingIndicator(
          { kind: "reading-indicator", key: "parent-wait", startedAt },
          { waitingSubagents, onOpenSession, outputTokens: 4_700, workingPhrases: ["Building"] },
        ),
        container,
      );
    draw(2_000);
    expect(container.textContent).toContain("Waiting on subagents");
    expect(container.querySelector("openclaw-working-phrase")).toBeNull();
    expect(container.querySelector(".chat-working-indicator__tokens")).toBeNull();
    expect(container.querySelector("openclaw-elapsed-time")).toHaveProperty("startMs", 2_000);
    container.querySelector("button")?.click();
    expect(onOpenSession).toHaveBeenCalledWith(child.key);
    draw(2_000);
    expect(container.querySelector("openclaw-elapsed-time")).toHaveProperty("startMs", 2_000);
    draw(null);
    expect(container.querySelector("openclaw-elapsed-time")).toBeNull();
  });
});
