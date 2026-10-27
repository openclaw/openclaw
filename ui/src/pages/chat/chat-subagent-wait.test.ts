import { createComponent, createSignal } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { listSubagents, projectSubagentStatus } from "./chat-subagent-wait.ts";
import { UnplacedSubagentWait } from "./components/chat-message-stream-view.tsx";
import {
  SubagentActivity,
  type SubagentActivityProps,
} from "./components/chat-subagent-activity.tsx";
import { ChatWorkingIndicator } from "./components/chat-working-indicator.tsx";

type ChatWorkingIndicatorOptions = Parameters<typeof ChatWorkingIndicator>[0]["options"];

function status(
  input: Partial<Parameters<typeof projectSubagentStatus>[0]> = {},
  searching = false,
) {
  return projectSubagentStatus(
    {
      selectedSession: parent,
      messages,
      subagentSessions: [child],
      subagentSessionsHydrated: true,
      ...input,
    },
    searching,
  );
}

const activity = (rows: GatewaySessionRow[]) =>
  listSubagents({
    selectedSession: parent,
    subagentSessions: rows,
    subagentSessionsHydrated: true,
  });

function mountWorkingIndicator(
  container: HTMLElement,
  part: Parameters<typeof ChatWorkingIndicator>[0]["part"],
  initial: ChatWorkingIndicatorOptions = {},
) {
  const [options, setOptions] = createSignal(initial);
  const view = mountSolid(
    () =>
      createComponent(ChatWorkingIndicator, {
        part,
        get options() {
          return options();
        },
      }),
    { container },
  );
  onTestFinished(view.unmount);
  flush();
  return (next: ChatWorkingIndicatorOptions) => {
    setOptions(next);
    flush();
  };
}

const parent: GatewaySessionRow = {
  key: "agent:main:parent",
  kind: "direct",
  hasActiveRun: false,
  hasActiveSubagentRun: true,
  startedAt: 1_000,
  endedAt: 2_000,
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
  it("keeps Details activity scoped to current runs and independent of transcript search", () => {
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
    const initial = status({ subagentSessions: [delegated, queued, active] });
    const initialRows = activity([delegated, queued, active]);
    const updatedSessions = [
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
    ];
    const updated = status({ subagentSessions: updatedSessions });
    expect([updated.statusKey, updated.rowsKey]).toEqual([initial.statusKey, initial.rowsKey]);
    const updatedRows = activity(updatedSessions);
    expect(initialRows.map((row) => row.status)).toEqual(["running", "queued", "waiting"]);
    expect(
      activity([{ ...active, activeRunIds: ["replacement-run"] }])[0]?.activity,
    ).toBeUndefined();
    expect(activity([{ ...active, status: "done", hasActiveRun: false }])).toMatchObject([
      { status: "done", activity: undefined },
    ]);
    expect(status({ subagentSessions: [active] }, true).placedWait).toBeUndefined();

    const onOpenSubagent = vi.fn();
    const onOpenSession = vi.fn();
    let update!: (props: SubagentActivityProps) => void;
    const view = mountSolid(() => {
      const [props, setProps] = createSignal<SubagentActivityProps>({
        rows: initialRows,
        onOpenSubagent,
        onOpenSession,
      });
      update = (value) => setProps(value);
      return createComponent(SubagentActivity, {
        get rows() {
          return props().rows;
        },
        get onOpenSubagent() {
          return props().onOpenSubagent;
        },
        get onOpenSession() {
          return props().onOpenSession;
        },
      });
    });
    const container = view.container;
    for (const text of [
      child.label,
      active.observerDigest.headline,
      queued.label,
      "Queued",
      delegated.label,
      "Waiting on subagents",
    ]) {
      expect(container.textContent).toContain(text);
    }
    container.querySelector("button")?.click();
    expect(onOpenSubagent).toHaveBeenCalledWith(child.key);
    const acp = activity([{ ...active, key: "agent:main:acp:coder" }]);
    update({ rows: acp, onOpenSubagent, onOpenSession });
    flush();
    container.querySelector("button")?.click();
    expect(onOpenSession).toHaveBeenCalledWith("agent:main:acp:coder");
    update({ rows: updatedRows });
    flush();
    expect(container.textContent).toContain("Running the backend tests");
    expect(container.textContent).not.toContain("Checking the API response");
    expect(container.querySelector("button")).toBeNull();
  });

  it.each<[string, GatewaySessionRow, boolean, boolean]>([
    ["idle parent", parent, false, true],
    ["local run", parent, true, false],
    ["row's own run", { ...parent, hasActiveRun: true }, false, false],
    ["settled children", { ...parent, hasActiveSubagentRun: false }, false, false],
    ["yielded parent", { ...parent, status: "running", activeRunIds: [] }, false, true],
  ])("%s", (_name, session, ownRunActive, waiting) => {
    const result = status({ selectedSession: session, runActive: ownRunActive }).wait;
    expect(result !== null).toBe(waiting);
    if (waiting) {
      expect(result).toEqual({
        startedAt: 2_000,
        runId: "parent-run",
        runningCount: 1,
      });
    }
  });

  it("waits for roster hydration and counts only unfinished direct subagents", () => {
    const derive = (childRows?: GatewaySessionRow[]) =>
      status({ subagentSessions: childRows, subagentSessionsHydrated: childRows !== undefined })
        .wait;
    expect(derive()).toEqual({ startedAt: 2_000, runId: "parent-run", runningCount: 0 });
    const summarize = (childRows: GatewaySessionRow[]) => {
      const wait = derive(childRows);
      return wait?.runningCount;
    };
    expect(summarize([child, { ...child, key: "agent:main:subagent:other" }])).toBe(2);
    expect(derive([{ ...child, spawnedBy: "agent:main:other" }])).toBeNull();
    expect(derive([{ ...child, hasActiveRun: false }])).toBeNull();
    expect(
      summarize([child, { ...child, key: "agent:main:grandchild", spawnedBy: child.key }]),
    ).toBe(1);
  });

  it("counts a child that handed off to its own subagents as unfinished", () => {
    const yielded = {
      ...child,
      key: "agent:main:subagent:yielded",
      status: "running" as const,
      hasActiveRun: false,
      hasActiveSubagentRun: true,
    };
    expect(status({ subagentSessions: [child, yielded] }).wait).toMatchObject({ runningCount: 2 });
  });

  it("counts child sessions that are not subagents without naming them", () => {
    const session = { ...child, key: "agent:main:dashboard:opened", label: "Opened session" };
    const derive = (rows: GatewaySessionRow[]) => status({ subagentSessions: rows }).wait;
    expect(derive([session])).toEqual({
      startedAt: 2_000,
      runId: "parent-run",
      runningCount: 0,
      sessionCount: 1,
    });
    const acp = { ...child, key: "agent:main:acp:coder", label: "Coder" };
    expect(derive([acp])).toMatchObject({ runningCount: 1 });
    expect(derive([child, session])).toMatchObject({
      runningCount: 1,
      sessionCount: 1,
    });
  });

  it("counts children only once the pane's own child query has answered", () => {
    const derive = (subagentSessionsHydrated: boolean) => status({ subagentSessionsHydrated }).wait;
    expect(derive(false)).toEqual({ startedAt: 2_000, runId: "parent-run", runningCount: 0 });
    expect(derive(true)).toMatchObject({ runningCount: 1 });
  });

  it.each([2_500, 1_500])("uses lifecycle end %i, not a later transcript timestamp", (endedAt) => {
    expect(status({ selectedSession: { ...parent, endedAt } }).wait?.startedAt).toBe(endedAt);
  });

  it("keeps lifecycle wait timing after an announcement resumes and settles the parent", () => {
    const dashboardChild = { ...child, key: "agent:main:dashboard:worker" };
    const project = (
      session: GatewaySessionRow,
      history: unknown[],
      descendants = [dashboardChild],
    ) => status({ selectedSession: session, messages: history, subagentSessions: descendants });
    expect(project({ ...parent, endedAt: 2_500 }, messages).wait?.startedAt).toBe(2_500);
    const resumed = { ...parent, startedAt: 3_000, endedAt: undefined, hasActiveRun: true };
    expect(project(resumed, messages).wait).toBeNull();
    const settled = { ...resumed, hasActiveRun: false, endedAt: 4_000 };
    const history = [
      ...messages,
      { role: "assistant", runId: "announcement", timestamp: 3_900, content: "Worker continues." },
    ];
    for (const loaded of [history, []]) {
      const projection = project(settled, loaded);
      expect(projection.wait).toEqual({
        startedAt: 4_000,
        runningCount: 0,
        sessionCount: 1,
      });
      expect(projection.placedWait).toBeUndefined();
    }
    expect(project(settled, history, []).wait).toBeNull();
  });

  it.each([
    [undefined, undefined],
    [1_000, undefined],
    [3_000, 2_000],
  ])("keeps child activity without inventing a wait (start=%s, end=%s)", (startedAt, endedAt) => {
    const projection = status({ selectedSession: { ...parent, startedAt, endedAt } });
    expect(projection.wait).toBeNull();
    expect(projection.running).toBe(1);
    expect(projection.listed).toBe(true);
  });

  it.each([{ history: [] }, { history: messages }])(
    "renders the recorded clock despite absent or earlier handoff: %j",
    ({ history }) => {
      const now = Date.UTC(2026, 9, 12, 20, 48);
      const wait = status({
        selectedSession: { ...parent, startedAt: now - 100_000, endedAt: now - 65_000 },
        messages: history,
        subagentSessionsHydrated: false,
      }).wait;
      expect(wait?.startedAt).toBe(now - 65_000);
      if (!wait) {
        throw new Error("Expected a settled parent wait");
      }
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      onTestFinished(() => clock.mockRestore());
      const view = mountSolid(() =>
        createComponent(UnplacedSubagentWait, {
          sessionKey: parent.key,
          wait,
          options: { waitingSubagents: wait },
        }),
      );
      onTestFinished(view.unmount);
      flush();
      expect(view.container.querySelector("openclaw-elapsed-time")?.textContent?.trim()).toBe(
        "1m 5s",
      );
    },
  );

  it("counts unfinished children beside the session's own work once the roster has loaded", () => {
    const working = { ...parent, hasActiveRun: true };
    const roster = [child, { ...child, key: "agent:main:subagent:other" }];
    const count = (input: Partial<Parameters<typeof projectSubagentStatus>[0]> = {}) =>
      status({
        selectedSession: working,
        subagentSessions: roster,
        runWorking: true,
        messages: [],
        ...input,
      }).running;
    expect(count()).toBe(2);
    expect(count({ subagentSessions: [{ ...child, hasActiveRun: false }] })).toBe(0);
    expect(
      count({ subagentSessions: [...roster, { ...child, key: "agent:main:dashboard:opened" }] }),
    ).toBe(2);
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
    expect(projectSubagentStatus({ ...input, selectedSession: parent }, false).wait).toEqual({
      startedAt: 2_000,
      runId: "parent-run",
      runningCount: 0,
    });
  });

  it("leads to the Subagents panel only when it lists every subagent the line mentions", () => {
    const listed = (subagentSessions: GatewaySessionRow[], working = true) =>
      status({
        selectedSession: working ? { ...parent, hasActiveRun: true } : parent,
        subagentSessions,
        runWorking: working,
        messages: working ? [] : messages,
      }).listed;
    expect(listed([child])).toBe(true);
    expect(listed([child], false)).toBe(true);
    const worker = { ...child, key: "agent:main:subagent:worker", swarmGroupId: "audit" };
    expect(listed([child, worker])).toBe(true);
    for (const key of ["agent:main:acp:coder", "agent:main:worker:unknown"]) {
      const unlisted = { ...child, key };
      expect(listed([unlisted], false)).toBe(false);
      expect(listed([child, unlisted], false)).toBe(false);
    }
    expect(listed([child, { ...child, key: "agent:main:dashboard:opened" }])).toBe(true);
    expect(listed([{ ...child, hasActiveRun: false }])).toBe(false);
  });

  it.each([false, true])(
    "keeps idle waits quiet and the footer count navigable (bubble mode: %s)",
    (bubbleMode) => {
      const now = 66_500;
      vi.spyOn(Date, "now").mockReturnValue(now);
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      const container = document.createElement("div");
      const onOpenSubagents = vi.fn();
      const wait = { startedAt: 1_500, runningCount: 1 };
      mountWorkingIndicator(
        container,
        { kind: "reading-indicator", key: "parent-wait", startedAt: 5_000 },
        {
          bubbleMode,
          waitingSubagents: wait,
          runningSubagents: wait.runningCount,
          onOpenSubagents,
          outputTokens: 4_700,
          workingPhrases: ["Building"],
        },
      );
      expect(
        container.querySelector(".chat-reading-indicator, .chat-bubble-dots--working"),
      ).toBeNull();
      expect(
        container.querySelector("openclaw-working-phrase, details, .chat-subagent-activity"),
      ).toBeNull();
      expect(container.textContent).not.toContain("Backend implementation");
      expect(container.textContent).toContain("4.7k output tokens");
      expect(container.querySelector("openclaw-elapsed-time")?.textContent).toBe("1m 5s");
      const count = container.querySelector<HTMLButtonElement>(
        ".chat-working-indicator__subagents",
      );
      expect(count?.textContent).toBe("1 subagent running");
      count?.click();
      expect(onOpenSubagents).toHaveBeenCalledOnce();
    },
  );

  it("makes the running count the way to the list when navigation is available", () => {
    const container = document.createElement("div");
    const onOpenSubagents = vi.fn();
    const update = mountWorkingIndicator(container, {
      kind: "reading-indicator",
      key: "parent-count",
      startedAt: 1_000,
    });
    const draw = (options: ChatWorkingIndicatorOptions) => update({ onOpenSubagents, ...options });
    const control = () => container.querySelector<HTMLButtonElement>("button");
    draw({ runningSubagents: 3 });
    expect(control()?.textContent?.trim()).toBe("3 subagents running");
    control()?.click();
    expect(onOpenSubagents).toHaveBeenCalledOnce();
    draw({ runningSubagents: 1, onOpenSubagents: undefined });
    expect(container.textContent).toContain("1 subagent running");
    expect(control()).toBeNull();
    draw({ runningSubagents: 0 });
    expect(container.querySelector(".chat-working-indicator__subagents")).toBeNull();
  });
});
