/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { ownSessionLaunchCalls, resolveSpawnedSubagent } from "./chat-spawned-subagent.ts";
import { indexRecordedSubagentStopNames } from "./chat-subagent-history.ts";
import { openAIModel } from "./chat-thread-fixtures.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatInto } from "./chat-view.test-helpers.ts";
import { selectActivityHeadline } from "./components/chat-activity-headline-selection.ts";
import { createActivityGroupHarness } from "./components/chat-message-native.test-support.tsx";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultBlock,
  createToolResultMessage,
} from "./components/chat-message.test-support.ts";
import { ChatToolCard } from "./components/chat-tool-cards.solid.tsx";
import { settleToolBridges } from "./components/chat-tool-render.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const parentKey = "agent:main:dashboard:11111111-1111-4111-8111-111111111111";
const label = "Write a six-line robot story";

function child(id: string, extra: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: `agent:main:subagent:${id}`,
    sessionId: id,
    kind: "direct",
    label,
    spawnedBy: parentKey,
    parentSessionKey: parentKey,
    status: "done",
    hasActiveRun: false,
    activeRunIds: [],
    runtimeMs: 42_000,
    updatedAt: 1,
    ...extra,
  };
}

function launch(extra: Partial<ToolCard> = {}): ToolCard {
  return {
    id: "spawn",
    callId: "spawn",
    name: "sessions_spawn",
    args: {
      label,
      taskName: "demo-mini-story",
      task: "Write the story. Reply with the result only.",
      runTimeoutSeconds: 180,
    },
    completed: true,
    ...extra,
  };
}

const accepted = (key: string) =>
  JSON.stringify({ status: "accepted", childSessionKey: key, runId: "child-run" }, null, 2);

type Render = ReturnType<typeof createActivityGroupHarness>["render"];
function harness() {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createActivityGroupHarness(container);
  onTestFinished(() => {
    root.unmount();
    container.remove();
  });
  const render = async (
    groups: Parameters<Render>[0],
    options: Partial<Parameters<Render>[1]> = {},
  ) => {
    root.render(groups, { showReasoning: false, showToolCalls: true, ...options });
    await settleToolBridges(container);
    return rowTexts(container);
  };
  return { container, render };
}

type Block = Record<string, unknown>;
const pair = (
  id: string,
  name: string,
  args: Record<string, unknown>,
  result?: string,
  extra?: Block,
): Block[] => [
  createToolCall(id, name, args),
  ...(result === undefined ? [] : [createToolResultBlock(id, name, result, extra)]),
];
const single = (content: Block[], extra: Block = {}) => [
  createToolGroup("single", [
    createMessageEntry("single", createAssistantMessage(content, { runId: "parent", ...extra })),
  ]),
];
const rowTexts = (container: HTMLElement) =>
  [...container.querySelectorAll(".chat-tool-row")].map((row) => row.textContent);
const cancelled = JSON.stringify({
  found: true,
  killed: true,
  targetState: { task: { status: "cancelled" } },
});

describe("a launched subagent", () => {
  const story = child("story");
  const running = { status: "running", hasActiveRun: true } satisfies Partial<GatewaySessionRow>;

  it("is named by its launch and finds its session from the result", () => {
    const finished = { key: story.key, listed: true, running: false, runtimeMs: 42_000 };
    const roster = [child("other", { label: "Other" }), story];
    // History keeps the result as text; a live result still carries details.
    for (const result of [
      { outputText: accepted(story.key) },
      { outputText: accepted(story.key), details: { sessionKey: story.key } },
      { details: { status: "accepted", childSessionKey: story.key } },
    ]) {
      expect(resolveSpawnedSubagent(launch(result), roster)).toEqual({ label, session: finished });
    }
    // Still at work, including while it waits on subagents of its own.
    for (const active of [running, { hasActiveSubagentRun: true }]) {
      expect(
        resolveSpawnedSubagent(launch({ outputText: accepted(story.key) }), [
          { ...story, ...active },
        ])?.session,
      ).toEqual({ key: story.key, listed: true, running: true, runtimeMs: null });
    }
  });

  it("leaves a launch that opened a session in its own right an ordinary operation", () => {
    const opened = child("opened", { key: "agent:main:dashboard:opened" });
    // Asked for with `visible`, or answered with a session that is not a subagent.
    const asked = launch({ callId: "asked", args: { label, task: "Write it.", visible: true } });
    const answered = launch({ callId: "answered", outputText: accepted(opened.key) });
    for (const card of [asked, answered]) {
      expect(resolveSpawnedSubagent(card, [story, opened])).toBeNull();
    }
    expect(ownSessionLaunchCalls([asked, answered, launch(), { ...asked, name: "exec" }])).toEqual(
      new Set(["asked", "answered"]),
    );
    // A subagent on the ACP runtime is a subagent before and after its result.
    const coder = child("coder", { key: "agent:main:acp:coder" });
    const acp = { label, task: "Write it.", runtime: "acp" };
    expect(resolveSpawnedSubagent(launch({ args: acp }), [coder])).toEqual({ label });
    expect(
      resolveSpawnedSubagent(launch({ args: acp, outputText: accepted(coder.key) }), [coder])
        ?.session?.key,
    ).toBe(coder.key);
  });

  it("keeps subagent and child-chat launches as standalone activity", async () => {
    const { container, render } = harness();
    // The live run prepares activity for both launches; a catalog alias is the same launch.
    const activity = ["story", "opened"].map((id): AgentActivityItem => ({
      itemId: `tool:${id}`,
      toolCallId: id,
      kind: "tool",
      phase: "end",
      status: "completed",
      name: "sessions_spawn",
      title: "Sub-agent",
    }));
    const content = [
      ...pair(
        "story",
        "mcp__openclaw__sessions_spawn",
        { label, task: "Write it." },
        accepted("agent:main:subagent:story"),
      ),
      ...pair(
        "opened",
        "sessions_spawn",
        { label: "Opened", task: "Write it.", visible: true },
        accepted("agent:main:dashboard:opened"),
      ),
    ];
    expect(await render(single(content, { activity }))).toEqual([
      `Launched ${label}`,
      "Opened child chatOpened",
    ]);
    expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
  });

  it("shows its historical name or recorded outcome, and opens its session without toggling the row", async () => {
    const onOpenSubagent = vi.fn();
    const onOpenSession = vi.fn();
    const onToggleExpanded = vi.fn();
    const mount = async (
      subagentSessions: GatewaySessionRow[],
      card = launch({ outputText: accepted(story.key) }),
      runActive = false,
    ) => {
      const container = document.createElement("div");
      document.body.append(container);
      onTestFinished(() => container.remove());
      mountSolid(
        ChatToolCard,
        {
          card,
          options: {
            messageKey: "message",
            expanded: false,
            runActive,
            onToggleExpanded,
            subagents: { subagentSessions, onOpenSubagent, onOpenSession },
          },
        },
        container,
      );
      await settleToolBridges(container);
      return container;
    };
    const row = await mount([story]);
    const link = row.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!;
    expect(link.textContent?.trim()).toBe(label);
    // The assignment and launch settings are detail, not the row's text.
    expect(row.querySelector(".chat-tool-disclosure__content")?.textContent).not.toMatch(
      /Reply with the result|demo-mini-story|180/u,
    );
    link.click();
    expect(onOpenSubagent).toHaveBeenCalledExactlyOnceWith(story.key);
    expect(onToggleExpanded).not.toHaveBeenCalled();
    (await mount([{ ...story, swarmGroupId: "parallel-audit" }]))
      .querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!
      .click();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onOpenSubagent).toHaveBeenNthCalledWith(2, story.key);
    row
      .querySelector<HTMLButtonElement>(".chat-tool-row--subagent > .chat-tool-row__toggle")!
      .click();
    expect(onToggleExpanded).toHaveBeenCalledOnce();

    // Later worker state never rewrites the historical launch row.
    const live = await mount([{ ...story, ...running }]);
    expect(live.querySelector(".chat-tool-row__subagent-state")).toBeNull();
    // A confirmed child key can open directly before roster hydration.
    const unlisted = await mount([]);
    unlisted.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!.click();
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(story.key);
    // An incomplete raw card uses the recorded launch outcome.
    for (const [status, expected] of [
      [undefined, "Subagent launch outcome unknown"],
      ["failed", "Couldn't launch subagent"],
    ] as const) {
      const activity: AgentActivityItem = {
        itemId: "tool:spawn",
        toolCallId: "spawn",
        kind: "tool",
        name: "sessions_spawn",
        title: "Sub-agent",
        phase: "start",
        status,
        unpairedCall: status === undefined,
      };
      const card = launch({ completed: undefined, live: true, activity });
      const raw = await mount([], card, status !== undefined);
      expect(raw.querySelector(".chat-tool-disclosure__content")?.textContent).toContain(expected);
    }
  });

  it("names the live headline instead of listing its launch settings", () => {
    const card = launch();
    const item: AgentActivityItem = {
      itemId: "tool:spawn",
      toolCallId: "spawn",
      kind: "tool",
      phase: "end",
      status: "completed",
      name: "sessions_spawn",
      title: `Sub-agent label ${label}, task name demo-mini-story, timeout 180`,
      meta: `label ${label}, task name demo-mini-story, timeout 180`,
    };
    expect(selectActivityHeadline([item], new Map([[card, item]]))).toMatchObject({
      title: `Subagent launch outcome unknown ${label}`,
      name: "sessions_spawn",
    });
    // A session opened in its own right is not named like a subagent.
    const opened = launch({ args: { ...(card.args as object), visible: true } });
    expect(selectActivityHeadline([item], new Map([[opened, item]]))).toMatchObject({
      title: `Child chat creation outcome unknown ${label}`,
    });
  });

  it("names the subagent a call addresses instead of its key's suffix", () => {
    const c = child("00000000-0000-4000-8000-000000007ef3");
    const headline = (
      name: string,
      args: Block,
      title: string,
      rows: GatewaySessionRow[] = [c],
      extra: Partial<ToolCard> = {},
    ) => {
      const card: ToolCard = { id: "call", callId: "call", name, args, ...extra };
      const item: AgentActivityItem = {
        itemId: "tool:call",
        toolCallId: "call",
        kind: "tool",
        phase: "start",
        status: "running",
        name,
        title,
        meta: "…7ef3",
      };
      return selectActivityHeadline([item], new Map([[card, item]]), rows)?.title;
    };
    const send = { sessionKey: c.key, message: "Hi" };
    expect(headline("sessions_send", send, "Send to session")).toBe(`Session Send ${label}`);
    // Before the roster holds it, the action stands in; the key never does.
    expect(headline("sessions_send", send, "Send to session", [])).toBe("Send to session");
    // Through the catalog dispatcher, and for history reads and steering.
    const dispatch = { id: "sessions_send", args: send };
    expect(headline("dispatch_action", dispatch, "Send to session")).toBe(`Session Send ${label}`);
    const read = { sessionKey: c.key };
    expect(headline("sessions_history", read, "Read session history")).toBe(
      `Reading chat ${label}`,
    );
    const steer = { action: "steer", target: c.key };
    expect(headline("subagents", steer, "Send to subagent", [])).toBe("Send to subagent");
    // A wait is never named after one of the runs it waits on.
    const completed = [{ runId: "run", sessionKey: c.key, label }];
    const waiting = [{ ...c, activeRunIds: ["run"] }];
    const waited = { details: { completed, pending: [] } };
    expect(headline("agents_wait", { ids: ["run"] }, "Wait for Agents", waiting, waited)).toBe(
      "Waiting for subagents",
    );
    // An unlabeled launch is named by the session its result names.
    const spawn = { outputText: accepted(c.key) };
    const unlabeled = (rows: GatewaySessionRow[]) =>
      headline("sessions_spawn", { task: "Write" }, "Start subagent", rows, spawn);
    expect(unlabeled([c])).toBe(`Launching ${label}`);
    expect(unlabeled([])).toBe("Start subagent");
  });
});

it("coalesces adjacent active and confirmed lifecycle calls without changing the first row", async () => {
  const { container, render: draw } = harness();
  const opened = new Map<string, boolean>();
  const call = (id: string, completed = true, args: Block = { label: "Cinder", task: "Work" }) =>
    pair(id, "sessions_spawn", args, completed ? accepted("agent:main:subagent:" + id) : undefined);
  // Each pair is one tool call and its optional result, streamed as its own message.
  const render = (pairs: Block[][]) =>
    draw(
      [
        createToolGroup(
          "lifecycle",
          pairs.map((blocks) =>
            createMessageEntry(
              "entry:" + String(blocks[0]!.id),
              createAssistantMessage(blocks, {
                runId: "parent",
                __openclawToolStreamLive: true,
                __openclawToolStreamResultReceived: blocks.length > 1,
              }),
            ),
          ),
        ),
      ],
      {
        runActive: true,
        subagents: { subagentSessions: [child("a", { label: "A" }), child("b", { label: "B" })] },
        isToolExpanded: (id) => opened.get(id) ?? false,
        onToggleToolExpanded: (id, expanded) => opened.set(id, !expanded),
      },
    );
  await render([call("a", false)]);
  const toggle = container.querySelector<HTMLButtonElement>(".chat-tool-row__toggle")!;
  toggle.focus();
  expect(await render([call("a", false), call("b", false)])).toEqual([
    "Launching Cinder and Cinder",
  ]);
  expect(await render([call("a"), call("b")])).toEqual(["Launched Cinder and Cinder"]);
  expect(document.activeElement).toBe(toggle);
  // Each coalesced child keeps its own disclosure state.
  toggle.click();
  await render([call("a"), call("b")]);
  const childToggles = [...container.querySelectorAll<HTMLElement>(".chat-tool-msg-summary")]
    .slice(1)
    .map((row) => row.querySelector<HTMLButtonElement>(".chat-tool-row__toggle") ?? row);
  childToggles[0]!.click();
  await render([call("a"), call("b")]);
  expect(childToggles.map((row) => row.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
  opened.clear();
  // A hidden wait still separates runs of launches; a failure is never merged.
  const wait = pair("wait", "agents_wait", { ids: ["a"] }, '{"completed":[],"pending":[]}');
  const denied = pair("failed", "sessions_spawn", { label: "Cinder" }, "Launch denied", {
    isError: true,
  });
  expect(await render([call("a"), call("b"), wait, call("c"), denied, call("d", false)])).toEqual([
    "Launched Cinder and Cinder",
    "Launched Cinder",
    "Couldn't launch subagent Cinder",
    "Launching Cinder",
  ]);
  const stop = (id: string) =>
    pair(
      "stop-" + id,
      "sessions",
      { action: "stop", sessionKey: "agent:main:subagent:" + id, runId: "run-" + id },
      JSON.stringify({ ok: true, abortedRunId: "run-" + id, status: "aborted" }),
    );
  expect(await render([stop("a"), stop("b")])).toEqual(["Stopped A and B"]);
  // Unnamed lifecycle events are counted by identity.
  const unnamed = ["x", "y", "z"];
  expect(await render(unnamed.map((id) => call(id, true, { task: "Work" })))).toEqual([
    "Launched 3 agents",
  ]);
  expect(
    await render(unnamed.map((id) => pair(id, "subagents", { action: "cancel", runId: id }))),
  ).toEqual(["Stopping 3 agents"]);
});

it("names a stop from the roster or its recorded launch, keeping its outcome", async () => {
  const { render } = harness();
  const worker = child("roster-only", { label: "Cinder", activeRunIds: ["child-run"] });
  const message = (id: string, blocks: Block[]) =>
    createAssistantMessage(blocks, { runId: "parent", __openclaw: { id } });
  const launchResult = { status: "accepted", childSessionKey: worker.key, runId: "child-run" };
  const prior = message(
    "launch-result",
    pair("launch-result", "sessions_spawn", { label: "Cinder" }, JSON.stringify(launchResult)),
  );
  const cancel = (result: object, extra?: Block) =>
    message(
      "stop-result",
      pair(
        "stop",
        "subagents",
        { action: "cancel", runId: "child-run" },
        JSON.stringify(result),
        extra,
      ),
    );
  const olderRun = message(
    "older-launch-result",
    pair(
      "launch-result",
      "sessions_spawn",
      { label: "Other run" },
      JSON.stringify({ ...launchResult, runId: "older-child-run" }),
    ),
  );
  const failed = cancel({ found: true, killed: false }, { isError: true });
  const stop = cancel({ ...JSON.parse(cancelled), sessionKey: worker.key });
  const at = <T extends object>(source: T, id: string, rawSeq: number) => ({
    ...source,
    __openclaw: { id, transcriptPosition: { source: "history", rawSeq } },
  });
  const positionedStop = at(stop, "stop-result", 35);
  for (const [current, history, expected, roster = []] of [
    [failed, [], "Stop subagent Cinderfailed", [worker]],
    // After the child leaves the roster, only its recorded launch names the stop.
    [stop, [prior, stop], "Stopped Cinder"],
    // Another child run, a later launch or another parent run never names it; transcript positions outrank array order.
    [stop, [olderRun, stop], "Stopped an agent"],
    [stop, [stop, prior], "Stopped an agent"],
    [positionedStop, [at(prior, "future-launch", 40), positionedStop], "Stopped an agent"],
    [{ ...stop, runId: "other-parent" }, [prior, stop], "Stopped an agent"],
  ] as const) {
    const subagents = {
      subagentSessions: [...roster],
      recordedStopNames: indexRecordedSubagentStopNames([...history]),
    };
    const group = createToolGroup("stop", [createMessageEntry("stop-entry", current)]);
    expect(await render([group], { subagents })).toEqual([expected]);
  }
  // The stopped name opens the session its stop receipt recorded.
  const onOpenSession = vi.fn();
  await render([createToolGroup("stop", [createMessageEntry("stop-entry", stop)])], {
    subagents: { recordedStopNames: indexRecordedSubagentStopNames([prior, stop]), onOpenSession },
  });
  document.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!.click();
  expect(onOpenSession).toHaveBeenCalledWith(worker.key);
});

it("retains an unlabeled historical launch disclosure while its roster name hydrates", async () => {
  const { container, render } = harness();
  const result = createToolResultMessage("spawn", "sessions_spawn", accepted(child("x").key));
  const draw = (rows: GatewaySessionRow[]) =>
    render([createToolGroup("hydrated", [createMessageEntry("result", result)])], {
      subagents: { subagentSessions: rows, onOpenSession: vi.fn() },
    });
  await draw([]);
  const toggle = container.querySelector<HTMLButtonElement>(".chat-tool-row__toggle")!;
  toggle.focus();
  await draw([child("x", { label: "Cinder" })]);
  expect(document.activeElement).toBe(toggle);
  expect(container.querySelector(".chat-tool-row__subagent-link")?.textContent).toBe("Cinder");
});

it("keeps parent interruption visible for an unrecorded lifecycle call without replacing a result", async () => {
  const { container, render } = harness();
  for (const [name, args, done, settled] of [
    ["sessions_spawn", { label: "Cinder" }, accepted("agent:main:subagent:child"), "Launched"],
    ["subagents", { action: "cancel", runId: "child" }, cancelled, "Stopped"],
  ] as const) {
    for (const result of [undefined, done]) {
      await render(single(pair("attempt", name, args, result)), {
        interruptedRunIds: new Set(["parent"]),
        isToolExpanded: () => true,
      });
      const text = container.querySelector(".chat-tool-row")!.textContent!;
      expect(text.includes("interrupted")).toBe(result === undefined);
      expect(text).toContain(result ? settled : "interrupted");
    }
  }
});

it("opens a grouped child chat through the full view navigation action", async () => {
  installTranscriptDomMocks();
  onTestFinished(() => {
    resetChatViewState();
    resetTranscriptTestDom();
  });
  const container = createComposerContainer();
  const childKey = "agent:research:dashboard:notes";
  const onOpenSessionLink = vi.fn();
  renderChatInto(container, {
    sessionKey: parentKey,
    onOpenSessionLink,
    messages: [
      { role: "user", content: "Read the source and open a notes chat.", timestamp: 1 },
      createAssistantMessage(
        [
          ...pair("read", "read", { path: "/repo/source.ts" }, "Source loaded."),
          ...pair("child", "sessions_spawn", { label: "Notes", visible: true }, accepted(childKey)),
          ...pair("write", "write", { path: "/repo/result.ts", content: "Ready." }, "Written."),
        ],
        { ...openAIModel, runId: "parent", timestamp: 2 },
      ),
      {
        role: "assistant",
        ...openAIModel,
        runId: "parent",
        content: "Notes are ready.",
        phase: "final_answer",
        timestamp: 3,
      },
    ],
  });
  await waitForSolid(() => {
    expect(
      container.querySelector(".chat-work-group > .chat-activity-group__summary"),
    ).not.toBeNull();
  });
  container
    .querySelector<HTMLButtonElement>(".chat-work-group > .chat-activity-group__summary")!
    .click();
  await waitForSolid(() => {
    expect(
      container.querySelector(
        ".chat-activity-group:not(.chat-work-group) > .chat-activity-group__summary",
      ),
    ).not.toBeNull();
  });
  container
    .querySelector<HTMLButtonElement>(
      ".chat-activity-group:not(.chat-work-group) > .chat-activity-group__summary",
    )!
    .click();
  await waitForSolid(() => {
    expect(container.textContent).toContain("Opened child chat");
  });
  const link = [
    ...container.querySelectorAll<HTMLButtonElement>(".chat-tool-row__subagent-link"),
  ].find((button) => button.textContent === "Notes");
  expect(link).toBeDefined();
  link!.click();
  expect(onOpenSessionLink).toHaveBeenCalledExactlyOnceWith({
    sessionKey: childKey,
    agentId: "research",
  });
});
