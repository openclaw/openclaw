import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { resolveChatSubagentWait, type ChatSubagentWait } from "./chat-subagent-wait.ts";
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
    runId: "parent-run",
    timestamp: 2_000,
    content: [{ type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} }],
  },
  {
    role: "toolResult",
    runId: "parent-run",
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
      subagentSessionsHydrated: true,
    });
    expect(result !== null).toBe(waiting);
    if (waiting) {
      expect(result).toEqual({
        startedAt: 2_000,
        runId: "parent-run",
        runningCount: 1,
        child: { key: child.key, label: child.label },
      });
    }
  });

  it("does not need child rows, counts running direct children and links a sole one", () => {
    const derive = (childRows?: GatewaySessionRow[]) =>
      resolveChatSubagentWait({
        selectedSession: parent,
        runActive: false,
        messages,
        subagentSessions: childRows,
        subagentSessionsHydrated: childRows !== undefined,
      });
    expect(derive()).toEqual({ startedAt: 2_000, runId: "parent-run", runningCount: 0 });
    const summarize = (childRows: GatewaySessionRow[]) => {
      const wait = derive(childRows);
      return [wait?.runningCount, wait?.child?.key];
    };
    expect(summarize([child, { ...child, key: "agent:main:subagent:other" }])).toEqual([
      2,
      undefined,
    ]);
    // Once the pane holds every child and none is unfinished, nothing is waited on.
    expect(derive([{ ...child, spawnedBy: "agent:main:other" }])).toBeNull();
    expect(derive([{ ...child, hasActiveRun: false }])).toBeNull();
    expect(
      summarize([child, { ...child, key: "agent:main:grandchild", spawnedBy: child.key }]),
    ).toEqual([1, child.key]);
  });

  it("counts a child that handed off to its own subagents as unfinished", () => {
    const yielded = {
      ...child,
      key: "agent:main:subagent:yielded",
      status: "running" as const,
      hasActiveRun: false,
      hasActiveSubagentRun: true,
    };
    expect(
      resolveChatSubagentWait({
        selectedSession: parent,
        runActive: false,
        messages,
        subagentSessions: [child, yielded],
        subagentSessionsHydrated: true,
      }),
    ).toMatchObject({ runningCount: 2 });
  });

  it("counts child sessions that are not subagents without naming them", () => {
    const session = { ...child, key: "agent:main:dashboard:opened", label: "Opened session" };
    const derive = (rows: GatewaySessionRow[]) =>
      resolveChatSubagentWait({
        selectedSession: parent,
        runActive: false,
        messages,
        subagentSessions: rows,
        subagentSessionsHydrated: true,
      });
    expect(derive([session])).toEqual({
      startedAt: 2_000,
      runId: "parent-run",
      runningCount: 0,
      sessionCount: 1,
    });
    // A subagent on the ACP runtime is a subagent like any other.
    const acp = { ...child, key: "agent:main:acp:coder", label: "Coder" };
    expect(derive([acp])).toMatchObject({ runningCount: 1, child: { key: acp.key } });
    // Subagents come first: the other sessions are counted once none is left.
    expect(derive([child, session])).toMatchObject({
      runningCount: 1,
      sessionCount: 1,
      child: { key: child.key },
    });
  });

  it("names or counts children only once the pane's own child query has answered", () => {
    const derive = (subagentSessionsHydrated: boolean) =>
      resolveChatSubagentWait({
        selectedSession: parent,
        runActive: false,
        messages,
        subagentSessions: [child],
        subagentSessionsHydrated,
      });
    // A row seeded from another list is not proof that it is the only child left.
    expect(derive(false)).toEqual({ startedAt: 2_000, runId: "parent-run", runningCount: 0 });
    expect(derive(true)).toMatchObject({ runningCount: 1, child: { key: child.key } });
  });

  it.each([
    { name: "the parent's run end", endedAt: 2_500, startedAt: 2_500 },
    { name: "the yield when the row's run end is older", endedAt: 1_500, startedAt: 2_000 },
  ])("counts the wait from $name", ({ endedAt, startedAt }) => {
    expect(
      resolveChatSubagentWait({
        selectedSession: { ...parent, endedAt },
        runActive: false,
        messages,
      })?.startedAt,
    ).toBe(startedAt);
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
    ).toEqual({ startedAt: null, runningCount: 0 });
  });

  it("renders the wait without parent output usage or rotating phrases and navigates the child", () => {
    const container = document.createElement("div");
    const onOpenSession = vi.fn();
    const sole = { key: child.key, label: child.label! };
    const draw = (waitingSubagents: ChatSubagentWait) =>
      render(
        renderChatWorkingIndicator(
          { kind: "reading-indicator", key: "parent-wait", startedAt: 1_500 },
          { waitingSubagents, onOpenSession, outputTokens: 4_700, workingPhrases: ["Building"] },
        ),
        container,
      );
    draw({ startedAt: 2_000, runningCount: 1, child: sole });
    expect(container.textContent?.replace(/\s+/g, " ")).toContain(
      "Waiting on Backend implementation",
    );
    expect(container.querySelector("openclaw-working-phrase")).toBeNull();
    expect(container.querySelector(".chat-working-indicator__tokens")).toBeNull();
    // The wait counts from the handoff, not from the indicator item.
    expect(container.querySelector("openclaw-elapsed-time")).toHaveProperty("startMs", 2_000);
    container.querySelector("button")?.click();
    expect(onOpenSession).toHaveBeenCalledWith(child.key);
    draw({ startedAt: 2_000, runningCount: 3 });
    expect(container.textContent).toContain("Waiting on 3 subagents");
    expect(container.querySelector("button")).toBeNull();
    draw({ startedAt: null, runningCount: 0 });
    expect(container.textContent).toContain("Waiting on subagents");
    expect(container.querySelector("openclaw-elapsed-time")).toBeNull();
    draw({ startedAt: 2_000, runningCount: 0, sessionCount: 2 });
    expect(container.textContent).toContain("Waiting on 2 sessions");
    expect(container.querySelector("button")).toBeNull();
    draw({ startedAt: 2_000, runningCount: 0, sessionCount: 1 });
    expect(container.textContent).toContain("Waiting on 1 session");
    // A subagent still running is what the line names.
    draw({ startedAt: 2_000, runningCount: 1, sessionCount: 2, child: sole });
    expect(container.textContent?.replace(/\s+/g, " ")).toContain(
      "Waiting on Backend implementation",
    );
  });
});
