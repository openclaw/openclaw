import { createComponent, createSignal } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import {
  handoffSessionLinks,
  listResumedHandoffSessions,
  listSubagents,
  projectProgressCardRuntime,
  projectSubagentStatus,
} from "./chat-subagent-wait.ts";
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
        sessions: [{ key: child.key, label: "Backend implementation", status: "running" }],
      });
    }
  });

  it("waits for roster hydration and counts only unfinished direct subagents", () => {
    const derive = (childRows?: GatewaySessionRow[]) =>
      status({ subagentSessions: childRows, subagentSessionsHydrated: childRows !== undefined })
        .wait;
    expect(derive()).toEqual({
      startedAt: 2_000,
      runId: "parent-run",
      runningCount: 0,
      sessions: [],
    });
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

  it("counts child sessions that are not subagents apart and names them on the wait", () => {
    const session = { ...child, key: "agent:main:dashboard:opened", label: "Opened session" };
    const derive = (rows: GatewaySessionRow[]) => status({ subagentSessions: rows }).wait;
    expect(derive([session])).toEqual({
      startedAt: 2_000,
      runId: "parent-run",
      runningCount: 0,
      sessionCount: 1,
      sessions: [{ key: session.key, label: "Opened session", status: "running" }],
    });
    const acp = { ...child, key: "agent:main:acp:coder", label: "Coder" };
    expect(derive([acp])).toMatchObject({ runningCount: 1 });
    expect(derive([child, session])).toMatchObject({
      runningCount: 1,
      sessionCount: 1,
    });
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
        sessions: [{ key: dashboardChild.key, label: "Backend implementation", status: "running" }],
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
      sessions: [],
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
    "names the one session a wait is on in place of the working text (bubble mode: %s)",
    (bubbleMode) => {
      const now = 66_500;
      vi.spyOn(Date, "now").mockReturnValue(now);
      onTestFinished(() => {
        vi.restoreAllMocks();
      });
      const container = document.createElement("div");
      const onOpenSessionLink = vi.fn();
      const wait = {
        startedAt: 1_500,
        runningCount: 1,
        sessions: [{ key: child.key, label: "Backend implementation", status: "running" as const }],
      };
      mountWorkingIndicator(
        container,
        { kind: "reading-indicator", key: "parent-wait", startedAt: 5_000 },
        {
          bubbleMode,
          waitingSubagents: wait,
          runningSubagents: wait.runningCount,
          sessionLinks: handoffSessionLinks({ subagentSessions: [child], onOpenSessionLink }),
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
      const line = container.querySelector(".chat-subagent-wait");
      expect(line?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
        "Waiting on Backend implementation · 1m 5s",
      );
      expect(container.querySelector(".chat-working-indicator__subagents")).toBeNull();
      expect(line?.querySelector("[aria-expanded]")).toBeNull();
      const name = line?.querySelector<HTMLAnchorElement>("a");
      expect(name?.getAttribute("href")).toBe("/chat/main/subagent/child");
      name?.click();
      expect(onOpenSessionLink).toHaveBeenCalledOnce();
    },
  );

  it("names and links no child until the pane's own child query is complete", () => {
    // Rows seeded from the sidebar can be a partial set: naming one would name
    // the wrong session, so the wait keeps its unnamed status until hydration.
    const sibling = { ...child, key: "agent:main:subagent:sibling", label: "Sibling" };
    const onOpenSessionLink = vi.fn();
    const handoff = { yieldedAt: 2_000, resumedAt: 3_000 };
    for (const roster of [
      { subagentSessions: [child], subagentSessionsHydrated: false },
      { subagentSessions: [child], subagentSessionsHydrated: true, subagentSessionsPending: true },
    ]) {
      const projection = status(roster);
      // Neither counted nor named until the child query answers.
      expect(projection.wait).toEqual({
        startedAt: 2_000,
        runId: "parent-run",
        runningCount: 0,
        sessions: [],
      });
      expect(listResumedHandoffSessions(parent.key, roster, handoff)).toEqual([]);
      const container = document.createElement("div");
      mountWorkingIndicator(
        container,
        { kind: "reading-indicator", key: "parent-wait", startedAt: 5_000 },
        {
          waitingSubagents: projection.wait!,
          sessionLinks: handoffSessionLinks({ ...roster, onOpenSessionLink }),
        },
      );
      expect(container.querySelector(".chat-subagent-wait, a")).toBeNull();
      expect(container.textContent).not.toContain(child.label);
    }
    // Once the child query answers, the complete set is named and linked.
    const complete = { subagentSessions: [child, sibling], subagentSessionsHydrated: true };
    expect(status(complete).wait?.sessions.map((session) => session.key)).toEqual([
      child.key,
      sibling.key,
    ]);
    const finished = { hasActiveRun: false, status: "done" as const, endedAt: 2_500 };
    expect(
      listResumedHandoffSessions(
        parent.key,
        {
          subagentSessions: [
            { ...child, ...finished },
            { ...sibling, ...finished },
          ],
          subagentSessionsHydrated: true,
        },
        handoff,
      ).map((session) => session.key),
    ).toEqual([child.key, sibling.key]);
  });

  it("lists a resumed handoff's children from runs that overlapped it", () => {
    const roster = (rows: GatewaySessionRow[]) => ({
      subagentSessions: rows,
      subagentSessionsHydrated: true,
    });
    const handoff = { yieldedAt: 2_000, resumedAt: 3_000 };
    const finished = { hasActiveRun: false, status: "done" as const };
    const during = { ...child, ...finished, createdAt: 1_000, startedAt: 1_000, endedAt: 2_500 };
    // Created before the handoff and finished before it: not waited on.
    const before = { ...during, key: "agent:main:subagent:before", endedAt: 1_500 };
    // The same kind of child, started again after the resume: its current run
    // is later work, and the row keeps no record of the earlier one.
    const restarted = {
      ...child,
      key: "agent:main:subagent:restarted",
      createdAt: 1_000,
      startedAt: 4_000,
      hasActiveRun: true,
    };
    expect(
      listResumedHandoffSessions(parent.key, roster([during, before, restarted]), handoff).map(
        (session) => session.key,
      ),
    ).toEqual([during.key]);
  });

  it("links child names only to sessions this pane loaded and can open", () => {
    const onOpenSessionLink = vi.fn();
    const dashboard = {
      ...child,
      key: "agent:main:dashboard:docs",
      label: "Docs",
      boardFace: "dashboard" as const,
    };
    const links = handoffSessionLinks({
      subagentSessions: [child, dashboard],
      basePath: "/ui",
      onOpenSessionLink,
    });
    expect(links?.(child.key)?.href).toBe("/ui/chat/main/subagent/child");
    expect(links?.(dashboard.key)?.href).toBe("/ui/dashboard/main/dashboard/docs");
    links?.(dashboard.key)?.open();
    expect(onOpenSessionLink).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "dashboard",
        pathname: "/ui/dashboard/main/dashboard/docs",
      }),
    );
    // Not in the pane's access-scoped child rows, or no way to open sessions here: text.
    expect(links?.("agent:main:subagent:unloaded")).toBeUndefined();
    expect(handoffSessionLinks({ subagentSessions: [child] })).toBeUndefined();

    const container = document.createElement("div");
    const wait = {
      startedAt: 1_500,
      runningCount: 1,
      sessions: [
        { key: child.key, label: "Backend implementation", status: "running" as const },
        { key: "agent:main:subagent:unloaded", label: "Unloaded", status: "done" as const },
      ],
    };
    mountWorkingIndicator(
      container,
      { kind: "reading-indicator", key: "parent-wait", startedAt: 5_000 },
      { waitingSubagents: wait, sessionLinks: links },
    );
    const [linked, plain] = container.querySelectorAll("li");
    const anchor = linked?.querySelector<HTMLAnchorElement>("a");
    expect(anchor?.getAttribute("href")).toBe("/ui/chat/main/subagent/child");
    expect(plain?.querySelector("a")).toBeNull();
    expect(plain?.querySelector("span")?.textContent).toBe("Unloaded");
    onOpenSessionLink.mockClear();
    // Modified and middle clicks keep native link behavior for a new tab.
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { button: 1 }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      anchor?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onOpenSessionLink).not.toHaveBeenCalled();
    const plainClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(plainClick);
    expect(plainClick.defaultPrevented).toBe(true);
    expect(onOpenSessionLink).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: "chat", pathname: "/ui/chat/main/subagent/child" }),
    );
  });

  it("lists several sessions with statuses in words, attention first, open until closed", () => {
    const now = 66_500;
    vi.spyOn(Date, "now").mockReturnValue(now);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const rows: GatewaySessionRow[] = [
      { ...child, createdAt: 10 },
      {
        ...child,
        key: "agent:main:subagent:review",
        label: "Review",
        createdAt: 20,
        hasActiveRun: false,
        status: "done",
        endedAt: 3_000,
        agentStatus: { note: "Pick a merge method", attention: "hand", expiresAt: now + 60_000 },
      },
      {
        ...child,
        key: "agent:main:dashboard:docs",
        label: "Docs",
        createdAt: 30,
        hasActiveRun: false,
        status: "done",
        endedAt: 4_000,
      },
      // Finished before this handoff: not what it waits on.
      {
        ...child,
        key: "agent:main:subagent:earlier",
        label: "Earlier",
        hasActiveRun: false,
        status: "done",
        endedAt: 1_500,
      },
    ];
    const wait = status({ subagentSessions: rows }).wait;
    expect(wait?.sessions).toEqual([
      {
        key: "agent:main:subagent:review",
        label: "Review",
        status: "attention",
        note: "Pick a merge method",
      },
      { key: child.key, label: "Backend implementation", status: "running" },
      { key: "agent:main:dashboard:docs", label: "Docs", status: "done" },
    ]);
    const container = document.createElement("div");
    mountWorkingIndicator(
      container,
      { kind: "reading-indicator", key: "parent-wait", startedAt: 5_000 },
      { waitingSubagents: { ...wait!, startedAt: 1_500 } },
    );
    const toggle = container.querySelector<HTMLButtonElement>(".chat-subagent-wait__toggle");
    expect(toggle?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
      "Waiting on 3 sessions · 1 needs your input · 1m 5s",
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const list = container.querySelector(`#${toggle?.getAttribute("aria-controls")}`);
    expect(
      [...(list?.querySelectorAll("li") ?? [])].map((row) =>
        row.textContent?.replace(/\s+/gu, " ").trim(),
      ),
    ).toEqual(["Review Needs your input", "Backend implementation Running", "Docs Done"]);
    toggle?.click();
    flush();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("li")).toBeNull();
  });

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

it("counts only hydrated direct children and keeps current failures separate from saved progress", () => {
  const rows: GatewaySessionRow[] = [
    child,
    { ...child, key: "agent:main:queued", hasActiveRun: false, status: "queued" },
    {
      ...child,
      key: "agent:main:waiting",
      hasActiveRun: false,
      hasActiveSubagentRun: true,
      status: "done",
    },
    {
      ...child,
      key: "agent:main:failed",
      hasActiveRun: false,
      status: "failed",
      endedAt: 3000,
      lastRunError: "Access denied",
    },
    { ...child, key: "agent:main:stopped", hasActiveRun: false, status: "killed", endedAt: 3000 },
    { ...child, key: "agent:main:old", hasActiveRun: false, status: "failed", endedAt: 1000 },
    { ...child, key: "agent:main:unrelated", spawnedBy: "agent:main:other" },
  ];
  const roster = { subagentSessions: rows, subagentSessionsHydrated: true };
  expect(projectProgressCardRuntime(parent, roster, 2000)).toMatchObject({
    hasActiveSubagentRun: true,
    children: { running: 1, queued: 1, waiting: 1, failed: 1, stopped: 1 },
    childError: "Backend implementation: Access denied",
  });
  expect(
    projectProgressCardRuntime(parent, { ...roster, subagentSessionsPending: true }, 2000).children,
  ).toBeUndefined();
  expect(
    projectProgressCardRuntime(parent, { ...roster, subagentSessionsHydrated: false }, 2000)
      .children,
  ).toBeUndefined();
});

it("counts an interrupted child as stopped only for its current progress snapshot", () => {
  const session = { ...parent, hasActiveSubagentRun: false };
  const roster = {
    subagentSessions: [
      { ...child, status: "interrupted" as const, hasActiveRun: false, endedAt: 3000 },
    ],
    subagentSessionsHydrated: true,
  };
  expect(projectProgressCardRuntime(session, roster, 2000)).toMatchObject({
    hasActiveSubagentRun: false,
    children: { running: 0, queued: 0, waiting: 0, failed: 0, stopped: 1 },
  });
  expect(projectProgressCardRuntime(session, roster, 3001).children?.stopped).toBe(0);
});
