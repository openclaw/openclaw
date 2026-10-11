import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { projectSubagentStatus } from "./chat-subagent-wait.ts";
import { renderSubagentActivity } from "./components/chat-subagent-activity.ts";
import { renderChatWorkingIndicator } from "./components/chat-working-indicator.ts";

function resolveChatSubagentWait(input: Parameters<typeof projectSubagentStatus>[0]) {
  return projectSubagentStatus(input, false).wait;
}

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
  it("keeps each unfinished subagent's current activity visible without reviving old runs", () => {
    const active = {
      ...child,
      activeRunIds: ["backend-run"],
      createdAt: 1,
      observerDigest: {
        runId: "backend-run",
        headline: "Checking the API response",
        health: "on-track" as const,
        revision: 1,
        updatedAt: 3_000,
      },
    };
    const queued = {
      ...child,
      key: "agent:main:subagent:queued",
      label: "UI regression tests",
      createdAt: 2,
      status: "queued" as const,
      hasActiveRun: false,
    };
    const delegated = {
      ...child,
      key: "agent:main:subagent:review",
      label: "Review accessibility",
      createdAt: 3,
      hasActiveRun: false,
      hasActiveSubagentRun: true,
    };
    const project = (rows: GatewaySessionRow[], searching = false) =>
      projectSubagentStatus(
        {
          selectedSession: parent,
          messages,
          subagentSessions: rows,
          subagentSessionsHydrated: true,
        },
        searching,
      );
    const initial = project([delegated, queued, active]);
    expect(initial.activity).toMatchObject([
      {
        key: child.key,
        label: child.label,
        status: "running",
        activity: "Checking the API response",
        listed: true,
      },
      { key: queued.key, label: queued.label, status: "queued", activity: undefined, listed: true },
      {
        key: delegated.key,
        label: delegated.label,
        status: "waiting",
        activity: undefined,
        listed: true,
      },
    ]);
    const updated = project([
      {
        ...active,
        observerDigest: {
          ...active.observerDigest,
          headline: "Running the backend tests",
          revision: 2,
        },
      },
      queued,
      delegated,
    ]);
    expect(updated.statusKey).not.toBe(initial.statusKey);
    expect(updated.rowsKey).toBe(initial.rowsKey);
    expect(updated.activity[0]?.activity).toBe("Running the backend tests");
    expect(
      project([{ ...active, activeRunIds: ["replacement-run"] }]).activity[0]?.activity,
    ).toBeUndefined();
    expect(project([{ ...active, status: "done", hasActiveRun: false }]).activity).toEqual([]);
    expect(project([active], true).activity).toEqual([]);

    const container = document.createElement("div");
    const onOpenSubagent = vi.fn();
    const onOpenSession = vi.fn();
    render(renderSubagentActivity(initial.activity, onOpenSubagent, onOpenSession), container);
    expect(container.textContent).toContain("Backend implementation");
    expect(container.textContent).toContain("Checking the API response");
    expect(container.textContent).toContain("UI regression tests");
    expect(container.textContent).toContain("Queued");
    expect(container.textContent).toContain("Review accessibility");
    expect(container.textContent).toContain("Waiting on subagents");
    container.querySelector("button")?.click();
    expect(onOpenSubagent).toHaveBeenCalledWith(child.key);
    const acp = project([{ ...active, key: "agent:main:acp:coder" }]);
    render(renderSubagentActivity(acp.activity, onOpenSubagent, onOpenSession), container);
    container.querySelector("button")?.click();
    expect(onOpenSession).toHaveBeenCalledWith("agent:main:acp:coder");
    render(renderSubagentActivity(updated.activity), container);
    expect(container.textContent).toContain("Running the backend tests");
    expect(container.textContent).not.toContain("Checking the API response");
    expect(container.querySelector("button")).toBeNull();
  });

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

  it("counts unfinished children beside the session's own work once the roster has loaded", () => {
    const working = { ...parent, hasActiveRun: true };
    const roster = [child, { ...child, key: "agent:main:subagent:other" }];
    const count = (input: Partial<Parameters<typeof projectSubagentStatus>[0]> = {}) =>
      projectSubagentStatus(
        {
          selectedSession: working,
          subagentSessions: roster,
          subagentSessionsHydrated: true,
          runWorking: true,
          messages: [],
          ...input,
        },
        false,
      ).running;
    expect(count()).toBe(2);
    expect(count({ subagentSessions: [{ ...child, hasActiveRun: false }] })).toBe(0);
    // A child session opened in its own right is not a subagent.
    expect(
      count({ subagentSessions: [...roster, { ...child, key: "agent:main:dashboard:opened" }] }),
    ).toBe(2);
    // One on the ACP runtime is.
    expect(
      count({ subagentSessions: [...roster, { ...child, key: "agent:main:acp:coder" }] }),
    ).toBe(3);
    expect(count({ subagentSessionsHydrated: false })).toBe(0);
    expect(count({ selectedSession: { ...working, hasActiveSubagentRun: false } })).toBe(0);
    expect(count({ selectedSession: undefined })).toBe(0);
  });

  it("keeps an active parent's running count while a covering child read is pending", () => {
    const input = {
      selectedSession: { ...parent, hasActiveRun: true },
      subagentSessions: [child],
      subagentSessionsHydrated: true,
      subagentSessionsPending: true,
      messages,
    };
    expect(projectSubagentStatus(input, false)).toMatchObject({
      wait: null,
      running: 1,
      listed: true,
    });
    // If the parent hands off before that read answers, its wait is still generic.
    expect(projectSubagentStatus({ ...input, selectedSession: parent }, false).wait).toEqual({
      startedAt: 2_000,
      runId: "parent-run",
      runningCount: 0,
    });
  });

  it("leads to the Subagents panel only when it lists every subagent the line mentions", () => {
    const listed = (subagentSessions: GatewaySessionRow[], working = true) =>
      projectSubagentStatus(
        {
          selectedSession: working ? { ...parent, hasActiveRun: true } : parent,
          subagentSessions,
          subagentSessionsHydrated: true,
          runWorking: working,
          messages: working ? [] : messages,
        },
        false,
      ).listed;
    expect(listed([child])).toBe(true);
    expect(listed([child], false)).toBe(true);
    const worker = { ...child, key: "agent:main:subagent:worker", swarmGroupId: "audit" };
    expect(listed([child, worker])).toBe(true);
    expect(listed([{ ...child, key: "agent:main:acp:coder" }], false)).toBe(false);
    // A child session is not one of the line's subagents.
    expect(listed([child, { ...child, key: "agent:main:dashboard:opened" }])).toBe(true);
    expect(listed([{ ...child, hasActiveRun: false }])).toBe(false);
  });

  it("ends the working line with the running count", () => {
    const container = document.createElement("div");
    const draw = (options: Parameters<typeof renderChatWorkingIndicator>[1]) =>
      render(
        renderChatWorkingIndicator(
          { kind: "reading-indicator", key: "parent-working", startedAt: 1_000 },
          options,
        ),
        container,
      );
    const suffix = () =>
      container.querySelector(".chat-working-indicator__subagents")?.textContent?.trim();
    draw({ runningSubagents: 3, outputTokens: 431 });
    expect(suffix()).toBe("3 subagents running");
    expect(container.textContent).toContain("431 output tokens");
    draw({ runningSubagents: 1 });
    expect(suffix()).toBe("1 subagent running");
    draw({ runningSubagents: 0 });
    expect(suffix()).toBeUndefined();
  });

  it.each([false, true])(
    "leaves waiting text to the composer and retains child activity (bubble mode: %s)",
    (bubbleMode) => {
      const container = document.createElement("div");
      const onOpenSubagent = vi.fn();
      const projection = projectSubagentStatus(
        {
          selectedSession: parent,
          messages,
          subagentSessions: [child],
          subagentSessionsHydrated: true,
        },
        false,
      );
      const options = {
        bubbleMode,
        waitingSubagents: projection.wait ?? undefined,
        outputTokens: 4_700,
        workingPhrases: ["Building"],
      };
      const part = { kind: "reading-indicator" as const, key: "parent-wait", startedAt: 1_500 };
      render(renderChatWorkingIndicator(part, options), container);
      expect(container.textContent).toBe("");
      render(
        renderChatWorkingIndicator(part, {
          ...options,
          subagentActivity: html`${renderSubagentActivity(projection.activity, onOpenSubagent)}`,
        }),
        container,
      );
      expect(container.textContent).toContain("Backend implementation");
      expect(container.textContent).not.toContain("Waiting on");
      expect(container.querySelector(".chat-working-indicator")).toBeNull();
      container.querySelector("button")?.click();
      expect(onOpenSubagent).toHaveBeenCalledWith(child.key);
    },
  );

  it("makes the running count the way to the list when navigation is available", () => {
    const container = document.createElement("div");
    const onOpenSubagents = vi.fn();
    const draw = (options: Parameters<typeof renderChatWorkingIndicator>[1]) =>
      render(
        renderChatWorkingIndicator(
          { kind: "reading-indicator", key: "parent-count", startedAt: 1_000 },
          { onOpenSubagents, ...options },
        ),
        container,
      );
    const control = () => container.querySelector<HTMLButtonElement>("button");
    draw({ runningSubagents: 3 });
    expect(control()?.textContent?.trim()).toBe("3 subagents running");
    control()?.click();
    expect(onOpenSubagents).toHaveBeenCalledOnce();
    draw({ runningSubagents: 1, onOpenSubagents: undefined });
    expect(container.textContent).toContain("1 subagent running");
    expect(control()).toBeNull();
  });
});
