import { describe, expect, it, onTestFinished, vi } from "vitest";
/* @vitest-environment jsdom */
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ownSessionLaunchCalls, resolveSpawnedSubagent } from "./chat-spawned-subagent.ts";
import { indexRecordedSubagentStopNames } from "./chat-subagent-history.ts";
import { selectActivityHeadline } from "./components/chat-activity-headline-selection.ts";
import { ActivityGroup } from "./components/chat-message-group-view.tsx";
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

  it.each(["sessions_spawn", "mcp__openclaw__sessions_spawn", "mcp_openclaw_sessions_spawn"])(
    "keeps %s subagent and child-chat launches as standalone activity",
    async (toolName) => {
      const calls = [
        { id: "story", args: { label, task: "Write it." } },
        { id: "opened", args: { label: "Opened", task: "Write it.", visible: true } },
      ];
      const activity = calls.map(({ id }): AgentActivityItem => ({
        itemId: `tool:${id}`,
        toolCallId: id,
        kind: "tool",
        phase: "end",
        status: "completed",
        name: "sessions_spawn",
        title: "Sub-agent",
      }));
      const group = createToolGroup("launches", [
        createMessageEntry(
          "launches:entry",
          createAssistantMessage(
            calls.flatMap(({ id, args }) => [
              createToolCall(id, toolName, args),
              createToolResultBlock(
                id,
                toolName,
                accepted(`agent:main:${id === "opened" ? "dashboard" : "subagent"}:${id}`),
              ),
            ]),
            { activity },
          ),
        ),
      ]);
      const container = document.createElement("div");
      mountSolid(
        ActivityGroup,
        {
          groups: [group],
          options: { showToolCalls: true, showReasoning: false },
          presentation: "standalone",
        },
        container,
      );
      await settleToolBridges(container);
      await waitForSolid(() => {
        expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
        expect(container.textContent).toContain(`Launched ${label}`);
        expect(container.textContent).toContain("Opened child chatOpened");
      });
    },
  );

  it("shows its historical name without duration, and opens its session without toggling the row", async () => {
    const onOpenSubagent = vi.fn();
    const onOpenSession = vi.fn();
    const onToggleExpanded = vi.fn();
    const mount = async (subagentSessions: GatewaySessionRow[]) => {
      const container = document.createElement("div");
      document.body.append(container);
      onTestFinished(() => container.remove());
      mountSolid(
        ChatToolCard,
        {
          card: launch({ outputText: accepted(story.key) }),
          options: {
            messageKey: "message",
            expanded: false,
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
    expect(row.querySelector(".chat-tool-row__subagent-state")).toBeNull();
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

    const state = async (session: GatewaySessionRow) =>
      (await mount([session])).querySelector(".chat-tool-row__subagent-state");
    expect(await state({ ...story, ...running })).toBeNull();
    // Later worker failures do not rewrite the historical launch row.
    const failed = await state({ ...story, status: "failed", runtimeMs: 291 });
    expect(failed).toBeNull();

    expect(await state({ ...story, status: "killed" })).toBeNull();
    // A confirmed child key can open directly before roster hydration; no child status is invented.
    const unlisted = await mount([]);
    unlisted.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!.click();
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(story.key);
    expect(unlisted.querySelector(".chat-tool-row__subagent-state")).toBeNull();
  });

  it.each([
    { runActive: false, status: undefined, expected: "Subagent launch outcome unknown" },
    { runActive: true, status: "failed" as const, expected: "Couldn't launch subagent" },
    { runActive: true, status: "running" as const, expected: "Launching" },
  ])(
    "uses the recorded launch outcome with an incomplete raw card ($expected)",
    async ({ runActive, status, expected }) => {
      const card = launch({
        completed: undefined,
        live: true,
        activity: {
          itemId: "tool:spawn",
          toolCallId: "spawn",
          kind: "tool",
          name: "sessions_spawn",
          title: "Sub-agent",
          phase: "start",
          status,
          unpairedCall: status === undefined,
        },
      });
      const container = document.createElement("div");
      mountSolid(
        ChatToolCard,
        {
          card,
          options: { messageKey: "launch", expanded: false, runActive, onToggleExpanded: vi.fn() },
        },
        container,
      );
      await settleToolBridges(container);
      await waitForSolid(() => {
        expect(container.querySelector(".chat-tool-disclosure__content")?.textContent).toContain(
          expected,
        );
      });
      if (status) {
        const item: AgentActivityItem = {
          itemId: "tool:spawn",
          toolCallId: "spawn",
          kind: "tool",
          phase: "start",
          status,
          name: "sessions_spawn",
          title: "Sub-agent",
        };
        expect(selectActivityHeadline([item], new Map([[card, item]]))?.title).toBe(
          expected + " " + label,
        );
      }
    },
  );

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
    // The launch's result carries its own prepared item; the headline can hold either.
    const resultItem = { ...item };
    expect(selectActivityHeadline([resultItem], new Map([[card, resultItem]]))).toMatchObject({
      title: `Subagent launch outcome unknown ${label}`,
    });
    // A session opened in its own right is not named like a subagent.
    const opened = launch({ args: { ...(card.args as object), visible: true } });
    expect(selectActivityHeadline([item], new Map([[opened, item]]))).toMatchObject({
      title: `Child chat creation outcome unknown ${label}`,
    });
  });

  it("names the subagent a call addresses instead of its key's suffix", () => {
    const addressedChild = child("00000000-0000-4000-8000-000000007ef3");
    const address = (
      name: string,
      args: Record<string, unknown>,
      title: string,
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
      return (rows?: GatewaySessionRow[]) =>
        selectActivityHeadline([item], new Map([[card, item]]), rows)?.title;
    };
    const send = address(
      "sessions_send",
      { sessionKey: addressedChild.key, message: "Hi" },
      "Send to session",
    );
    expect(send([addressedChild])).toContain(label);
    // Before the roster holds it, the action stands in; the key never does.
    expect(send([])).toBe("Send to session");
    // Through the catalog dispatcher, and for history reads and steering.
    expect(
      address(
        "dispatch_action",
        { id: "sessions_send", args: { sessionKey: addressedChild.key, message: "Hi" } },
        "Send to session",
      )([addressedChild]),
    ).toContain(label);
    expect(
      address(
        "sessions_history",
        { sessionKey: addressedChild.key },
        "Read session history",
      )([addressedChild]),
    ).toContain(label);
    expect(
      address("subagents", { action: "steer", target: addressedChild.key }, "Send to subagent")([]),
    ).toBe("Send to subagent");
    const read = address(
      "sessions_history",
      { sessionKey: addressedChild.key },
      "Read session history",
    );
    expect(read([addressedChild])).toBe("Reading chat " + label);
    expect(read([])).toBe("Reading chat");
    expect(address("sessions_history", {}, "Read session history")([])).toBe("Reading chat");
    const wait = address("agents_wait", { ids: ["known-run"] }, "Wait for Agents");
    expect(wait([{ ...addressedChild, activeRunIds: ["known-run"] }])).toBe("Wait for subagents");
    expect(wait([])).toBe("Wait for subagents");
    expect(
      address("agents_wait", { ids: ["known-run"] }, "Wait for Agents", {
        details: {
          completed: [{ runId: "known-run", sessionKey: addressedChild.key, label }],
          pending: [],
        },
      })([]),
    ).toBe("Wait for subagents");
    // An unlabeled launch is named by the session its result names.
    const unlabeled = address("sessions_spawn", { task: "Write" }, "Start subagent", {
      outputText: accepted(addressedChild.key),
    });
    expect(unlabeled([addressedChild])).toContain(label);
    expect(unlabeled([])).toBe("Start subagent");
  });
});

it("coalesces adjacent active and confirmed lifecycle calls without changing the first row", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createActivityGroupHarness(container);
  onTestFinished(() => {
    root.unmount();
    container.remove();
  });
  const opened = new Map<string, boolean>();
  const call = (id: string, completed = true) => [
    createToolCall(id, "sessions_spawn", { label: "Cinder", task: "Work" }),
    ...(completed
      ? [createToolResultBlock(id, "sessions_spawn", accepted("agent:main:subagent:" + id))]
      : []),
  ];
  const render = (content: Record<string, unknown>[]) =>
    root.render(
      [
        createToolGroup(
          "lifecycle",
          content.flatMap((block) => {
            if (block.type !== "toolcall") {
              return [];
            }
            const result = content.find(
              (item) => item.type === "tool_result" && item.id === block.id,
            );
            return [
              createMessageEntry(
                "entry:" + String(block.id),
                createAssistantMessage([block, ...(result ? [result] : [])], {
                  runId: "parent",
                  __openclawToolStreamLive: true,
                  __openclawToolStreamResultReceived: Boolean(result),
                }),
              ),
            ];
          }),
        ),
      ],
      {
        showReasoning: false,
        showToolCalls: true,
        runActive: true,
        subagents: { subagentSessions: [child("a", { label: "A" }), child("b", { label: "B" })] },
        isToolExpanded: (id) => opened.get(id) ?? false,
        onToggleToolExpanded: (id, expanded) => opened.set(id, !expanded),
      },
    );
  render([createToolCall("a", "sessions_spawn", { label: "Cinder", task: "Work" })]);
  await settleToolBridges(container);
  const first = container.querySelector<HTMLButtonElement>(".chat-tool-row")!;
  const toggle = first.querySelector<HTMLButtonElement>(".chat-tool-row__toggle")!;
  toggle.focus();
  toggle.click();
  render(call("a", false));
  await settleToolBridges(container);
  expect(container.querySelectorAll(".chat-tool-msg-summary")).toHaveLength(1);
  expect(container.querySelector(".chat-tool-msg-body")).not.toBeNull();
  toggle.click();
  render(call("a", false));
  await settleToolBridges(container);
  for (const firstCompleted of [false, true]) {
    render([...call("a", firstCompleted), ...call("b", false)]);
    await settleToolBridges(container);
    expect(container.querySelectorAll(".chat-tool-row")).toHaveLength(1);
    expect(container.querySelector(".chat-tool-row")).toBe(first);
    expect(document.activeElement).toBe(toggle);
    expect(first.textContent).toBe("Launching Cinder and Cinder");
  }
  render([...call("a"), ...call("b")]);
  await settleToolBridges(container);
  expect(container.querySelector(".chat-tool-row")).toBe(first);
  expect(document.activeElement).toBe(toggle);
  expect(first.textContent).toBe("Launched Cinder and Cinder");
  toggle.click();
  render([...call("a"), ...call("b")]);
  await settleToolBridges(container);
  const rows = [...container.querySelectorAll<HTMLElement>(".chat-tool-msg-summary")];
  expect(rows).toHaveLength(3);
  const childToggles = rows
    .slice(1)
    .map((row) => row.querySelector<HTMLButtonElement>(".chat-tool-row__toggle") ?? row);
  expect(childToggles.map((row) => row.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  childToggles[0]!.click();
  render([...call("a"), ...call("b")]);
  await settleToolBridges(container);
  expect(childToggles.map((row) => row.getAttribute("aria-expanded"))).toEqual(["true", "false"]);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  opened.clear();
  render([
    ...call("a"),
    ...call("b"),
    createToolCall("wait", "agents_wait", { ids: ["a", "b"] }),
    createToolResultBlock("wait", "agents_wait", JSON.stringify({ completed: [], pending: [] })),
    ...call("c"),
  ]);
  await settleToolBridges(container);
  expect([...container.querySelectorAll(".chat-tool-row")].map((row) => row.textContent)).toEqual([
    "Launched Cinder and Cinder",
    "Launched Cinder",
  ]);
  expect(container.textContent).not.toContain("Waited");
  render([
    ...call("a"),
    ...call("failed", false),
    createToolResultBlock("failed", "sessions_spawn", "Launch denied", { isError: true }),
    ...call("c", false),
  ]);
  await settleToolBridges(container);
  expect([...container.querySelectorAll(".chat-tool-row")].map((row) => row.textContent)).toEqual([
    "Launched Cinder",
    "Couldn't launch subagent Cinder",
    "Launching Cinder",
  ]);

  render(
    ["a", "b"].flatMap((id) => [
      createToolCall("stop-" + id, "sessions", {
        action: "stop",
        sessionKey: "agent:main:subagent:" + id,
        runId: "run-" + id,
      }),
      createToolResultBlock(
        "stop-" + id,
        "sessions",
        JSON.stringify({ ok: true, abortedRunId: "run-" + id, status: "aborted" }),
        { isError: false },
      ),
    ]),
  );
  await settleToolBridges(container);
  expect([...container.querySelectorAll(".chat-tool-row")].map((row) => row.textContent)).toEqual([
    "Stopped A and B",
  ]);
  expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
});

it.each(["launch", "failed stop", "skipped stop", "confirmed stop"] as const)(
  "keeps the roster name and intrinsic outcome of a %s",
  async (kind) => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createActivityGroupHarness(container);
    onTestFinished(() => {
      root.unmount();
      container.remove();
    });
    const worker = child("roster-only", { label: "Cinder", activeRunIds: ["child-run"] });
    const onOpenSession = vi.fn();
    const name = kind === "launch" ? "sessions_spawn" : "subagents";
    const result =
      kind === "launch"
        ? accepted(worker.key)
        : JSON.stringify({
            found: true,
            killed: kind === "confirmed stop",
            sessionKey: worker.key,
            targetState: { task: { status: kind === "confirmed stop" ? "cancelled" : "running" } },
          });
    const operation = createAssistantMessage(
      [
        createToolCall(
          "intrinsic-call",
          name,
          kind === "launch" ? { task: "Work" } : { action: "cancel", runId: "child-run" },
        ),
        createToolResultBlock("intrinsic-call", name, result, {
          isError: kind === "failed stop",
          ...(kind === "skipped stop"
            ? { details: { status: "skipped", deniedReason: "steering" } }
            : {}),
        }),
      ],
      { runId: "parent", __openclaw: { id: "stop-result" } },
    );
    const render = (
      message: typeof operation,
      roster: GatewaySessionRow[],
      history: unknown[] = [],
    ) =>
      root.render(
        [createToolGroup("intrinsic", [createMessageEntry("intrinsic-entry", message)])],
        {
          showReasoning: false,
          showToolCalls: true,
          subagents: {
            subagentSessions: roster,
            onOpenSession,
            recordedStopNames: indexRecordedSubagentStopNames(history),
          },
        },
      );
    render(operation, [worker]);
    await settleToolBridges(container);
    const row = container.querySelector(".chat-tool-row")!;
    expect(row.textContent).toContain("Cinder");
    if (kind === "launch") {
      const link = row.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!;
      link.click();
      expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(worker.key);
    } else {
      expect(row.textContent).toContain(
        kind === "failed stop" ? "failed" : kind === "skipped stop" ? "Skipped" : "Stopped",
      );
      if (kind === "confirmed stop") {
        expect(row.querySelector(".chat-tool-failure, .chat-tool-skipped")).toBeNull();
        const prior = createAssistantMessage(
          [
            createToolCall("launch", "sessions_spawn", { label: "Cinder" }),
            createToolResultBlock(
              "launch",
              "sessions_spawn",
              JSON.stringify({
                status: "accepted",
                childSessionKey: worker.key,
                runId: "child-run",
                label: "Cinder",
              }),
            ),
          ],
          { runId: "parent", __openclaw: { id: "launch-result" } },
        );
        const differentRun = createAssistantMessage(
          [
            createToolCall("launch", "sessions_spawn", { label: "Other run" }),
            createToolResultBlock(
              "launch",
              "sessions_spawn",
              JSON.stringify({
                status: "accepted",
                childSessionKey: worker.key,
                runId: "older-child-run",
                label: "Other run",
              }),
            ),
          ],
          { runId: "parent", __openclaw: { id: "older-launch-result" } },
        );
        const currentRunStop = createAssistantMessage(
          [
            createToolCall("intrinsic-call", "sessions", {
              action: "stop",
              sessionKey: worker.key,
            }),
            createToolResultBlock(
              "intrinsic-call",
              "sessions",
              JSON.stringify({
                ok: true,
                status: "aborted",
                abortedRunId: "child-run",
              }),
            ),
          ],
          { runId: "parent", __openclaw: { id: "stop-current-result" } },
        );
        const otherParent = { ...operation, runId: "other-parent" };
        const positionedStop = {
          ...operation,
          __openclaw: {
            id: "stop-result",
            transcriptPosition: { source: "history", rawSeq: 35 },
          },
        };
        const futureLaunch = {
          ...prior,
          __openclaw: {
            id: "future-launch",
            transcriptPosition: { source: "history", rawSeq: 40 },
          },
        };
        for (const scenario of [
          { message: operation, history: [prior, operation], label: "Stopped Cinder" },
          { message: operation, history: [differentRun, operation], label: "Stopped an agent" },
          { message: operation, history: [operation, prior], label: "Stopped an agent" },
          {
            message: positionedStop,
            history: [futureLaunch, positionedStop],
            label: "Stopped an agent",
          },
          { message: operation, history: [operation], label: "Stopped an agent" },
          { message: currentRunStop, history: [prior, currentRunStop], label: "Stopped Cinder" },
          { message: otherParent, history: [prior, operation], label: "Stopped an agent" },
        ]) {
          render(scenario.message, [], scenario.history);
          await settleToolBridges(container);
          expect(container.querySelector(".chat-tool-row")?.textContent).toBe(scenario.label);
        }
      }
    }
    expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
  },
);

it.each([
  ["sessions_spawn", 1, "Launched an agent", false],
  ["sessions_spawn", 3, "Launched 3 agents", false],
  ["sessions_spawn", 3, "Launching 3 agents", true],
  ["subagents", 2, "Stopped 2 agents", false],
  ["subagents", 2, "Stopping 2 agents", true],
] as const)(
  "counts unnamed %s lifecycle events by identity (%s)",
  async (name, count, expected, running) => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createActivityGroupHarness(container);
    onTestFinished(() => {
      root.unmount();
      container.remove();
    });
    const content = Array.from({ length: count }, (_, index) => {
      const id = "unnamed-" + index;
      return [
        createToolCall(
          id,
          name,
          name === "sessions_spawn" ? { task: "Work" } : { action: "cancel", runId: id },
        ),
        ...(running
          ? []
          : [
              createToolResultBlock(
                id,
                name,
                name === "sessions_spawn"
                  ? accepted("agent:main:subagent:" + id)
                  : JSON.stringify({
                      found: true,
                      killed: true,
                      targetState: { task: { status: "cancelled" } },
                    }),
              ),
            ]),
      ];
    }).flat();
    root.render(
      [
        createToolGroup("unnamed", [
          createMessageEntry(
            "unnamed-entry",
            createAssistantMessage(content, { runId: "parent", __openclawToolStreamLive: running }),
          ),
        ]),
      ],
      { showReasoning: false, showToolCalls: true, runActive: running },
    );
    await settleToolBridges(container);
    expect(container.querySelector(".chat-tool-row")?.textContent?.trim()).toBe(expected);
    expect(container.textContent).not.toContain("unnamed-");
  },
);

it("retains an unlabeled historical launch disclosure while its roster name hydrates", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createActivityGroupHarness(container);
  onTestFinished(() => {
    root.unmount();
    container.remove();
  });
  const worker = child("hydrated", { label: "Cinder" });
  const onOpenSession = vi.fn();
  const group = createToolGroup("hydrated", [
    createMessageEntry(
      "result",
      createToolResultMessage("spawn", "sessions_spawn", accepted(worker.key), { runId: "parent" }),
    ),
  ]);
  const draw = (rows: GatewaySessionRow[]) =>
    root.render([group], {
      showReasoning: false,
      showToolCalls: true,
      subagents: { subagentSessions: rows, onOpenSession },
    });
  draw([]);
  await settleToolBridges(container);
  const toggle = container.querySelector<HTMLButtonElement>(".chat-tool-row__toggle")!;
  expect(toggle).not.toBeNull();
  toggle.focus();
  draw([worker]);
  await settleToolBridges(container);
  expect(container.querySelector(".chat-tool-row__toggle")).toBe(toggle);
  expect(document.activeElement).toBe(toggle);
  const link = container.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!;
  expect(link.textContent).toBe("Cinder");
  link.click();
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(worker.key);
});

it.each(["sessions_spawn", "subagents"] as const)(
  "keeps parent interruption visible for an unrecorded %s without replacing a result",
  async (name) => {
    const container = document.body.appendChild(document.createElement("div"));
    const root = createActivityGroupHarness(container);
    onTestFinished(() => {
      root.unmount();
      container.remove();
    });
    for (const completed of [false, true]) {
      const content = [
        createToolCall(
          "attempt",
          name,
          name === "sessions_spawn"
            ? { label: "Cinder", task: "Work" }
            : { action: "cancel", runId: "child" },
        ),
        ...(completed
          ? [
              createToolResultBlock(
                "attempt",
                name,
                name === "sessions_spawn"
                  ? accepted("agent:main:subagent:child")
                  : JSON.stringify({
                      found: true,
                      killed: true,
                      targetState: { task: { status: "cancelled" } },
                    }),
              ),
            ]
          : []),
      ];
      root.render(
        [
          createToolGroup("interruption", [
            createMessageEntry(
              "attempt-entry",
              createAssistantMessage(content, { runId: "parent" }),
            ),
          ]),
        ],
        {
          showReasoning: false,
          showToolCalls: true,
          interruptedRunIds: new Set(["parent"]),
          isToolExpanded: () => true,
        },
      );
      await settleToolBridges(container);
      const row = container.querySelector(".chat-tool-row")!;
      expect(row.textContent?.includes("interrupted")).toBe(!completed);
      if (completed) {
        expect(row.textContent).toContain(name === "sessions_spawn" ? "Launched" : "Stopped");
      }
    }
  },
);
