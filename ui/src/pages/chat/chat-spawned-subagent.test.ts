/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ToolCard } from "../../lib/chat/chat-types.ts";
import {
  ownSessionLaunchCalls,
  resolveSpawnedSubagent,
  spawnedSubagentsRenderKey,
} from "./chat-spawned-subagent.ts";
import { selectActivityHeadline } from "./components/chat-activity-headline.ts";
import { renderActivityGroup } from "./components/chat-message-group.ts";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
} from "./components/chat-message.test-support.ts";
import { renderToolCard } from "./components/chat-tool-cards.ts";

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

  it("never borrows a session from its name alone", () => {
    // In flight, refused, or naming a session the roster does not hold: the
    // one child carrying the same label is an earlier launch or a retry.
    for (const result of [
      {},
      { outputText: JSON.stringify({ status: "error", error: "cwd is outside the workspace" }) },
      { outputText: accepted("agent:main:subagent:gone") },
    ]) {
      expect(resolveSpawnedSubagent(launch(result), [story])).toEqual({ label });
    }
  });

  it("stays a generic row without a label", () => {
    const unlabeled = { taskName: "demo-mini-story", task: "Write the story." };
    expect(resolveSpawnedSubagent(launch({ args: unlabeled }), [story])).toBeNull();
    expect(resolveSpawnedSubagent({ ...launch(), name: "exec" }, [story])).toBeNull();
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

  it("counts a launch that opened a session in its own right with the other operations", () => {
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
          calls.map(({ id, args }) => createToolCall(id, "sessions_spawn", args)),
          { activity },
        ),
      ),
    ]);
    const container = document.createElement("div");
    render(renderActivityGroup([group], { showToolCalls: true, showReasoning: false }), container);
    expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
      "1 other operation · 1 subagent",
    );
  });

  it("says how a subagent ended when it did not finish its work", () => {
    const ended = (status: GatewaySessionRow["status"]) =>
      resolveSpawnedSubagent(launch({ outputText: accepted(story.key) }), [{ ...story, status }])
        ?.session?.ended;
    expect((["failed", "timeout", "killed", "interrupted", "done"] as const).map(ended)).toEqual([
      "failed",
      "failed",
      "stopped",
      "stopped",
      undefined,
    ]);
    // A launch row that only shows a duration must repaint when that changes.
    expect(spawnedSubagentsRenderKey([{ ...story, status: "failed" }])).not.toBe(
      spawnedSubagentsRenderKey([story]),
    );
  });

  it("repaints launch rows when a subagent starts or finishes, not when the roster reorders", () => {
    const puzzle = child("puzzle", { label: "Solve a tiny logic puzzle", ...running });
    const key = spawnedSubagentsRenderKey([story, puzzle]);
    // Activity patches move rows and touch fields no launch row draws.
    expect(spawnedSubagentsRenderKey([{ ...puzzle, updatedAt: 9 }, story])).toBe(key);
    expect(
      spawnedSubagentsRenderKey([story, { ...puzzle, status: "done", hasActiveRun: false }]),
    ).not.toBe(key);
    expect(spawnedSubagentsRenderKey([{ ...story, ...running }, puzzle])).not.toBe(key);
  });

  it("shows its name and duration, and opens its session without toggling the row", () => {
    const onOpenSubagent = vi.fn();
    const onOpenSession = vi.fn();
    const onToggleExpanded = vi.fn();
    const mount = (subagentSessions: GatewaySessionRow[]) => {
      const container = document.createElement("div");
      render(
        renderToolCard(launch({ outputText: accepted(story.key) }), {
          messageKey: "message",
          expanded: false,
          onToggleExpanded,
          subagents: { subagentSessions, onOpenSubagent, onOpenSession },
        }),
        container,
      );
      return container;
    };
    const row = mount([story]);
    const link = row.querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!;
    expect(link.textContent?.trim()).toBe(label);
    expect(row.querySelector(".chat-tool-row__subagent-state")?.textContent).toBe("42s");
    // The assignment and launch settings are detail, not the row's text.
    expect(row.querySelector(".chat-tool-disclosure__content")?.textContent).not.toMatch(
      /Reply with the result|demo-mini-story|180/u,
    );
    link.click();
    expect(onOpenSubagent).toHaveBeenCalledExactlyOnceWith(story.key);
    expect(onToggleExpanded).not.toHaveBeenCalled();
    // The Subagents panel does not list a swarm's workers, so one still opens as a session.
    mount([{ ...story, swarmGroupId: "parallel-audit" }])
      .querySelector<HTMLButtonElement>(".chat-tool-row__subagent-link")!
      .click();
    expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(story.key);
    expect(onOpenSubagent).toHaveBeenCalledOnce();
    row
      .querySelector<HTMLButtonElement>(".chat-tool-row--subagent > .chat-tool-row__toggle")!
      .click();
    expect(onToggleExpanded).toHaveBeenCalledOnce();

    const state = (session: GatewaySessionRow) =>
      mount([session]).querySelector(".chat-tool-row__subagent-state");
    expect(state({ ...story, ...running })?.textContent).toBe("running");
    // A subagent that failed says so instead of how long it lasted.
    const failed = state({ ...story, status: "failed", runtimeMs: 291 });
    expect(failed?.textContent).toBe("failed");
    expect(failed?.classList.contains("chat-tool-row__subagent-state--failed")).toBe(true);
    expect(state({ ...story, status: "killed" })?.textContent).toBe("stopped");
    // Without its session the row is the ordinary disclosure, still named.
    const unlinked = mount([]);
    expect(unlinked.querySelector(".chat-tool-row__subagent-link")).toBeNull();
    expect(unlinked.querySelector("button.chat-tool-row .chat-tool-row__title")?.textContent).toBe(
      label,
    );
    expect(unlinked.querySelector(".chat-tool-row__subagent-state")).toBeNull();
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
    expect(
      selectActivityHeadline([item], [{ card, children: [] }], new Map([[card, item]])),
    ).toMatchObject({ title: label, name: "sessions_spawn" });
    // The launch's result carries its own prepared item; the headline can hold either.
    expect(
      selectActivityHeadline([{ ...item }], [{ card, children: [] }], new Map([[card, item]])),
    ).toMatchObject({ title: label });
    // A session opened in its own right is not named like a subagent.
    const opened = launch({ args: { ...(card.args as object), visible: true } });
    expect(
      selectActivityHeadline([item], [{ card: opened, children: [] }], new Map([[opened, item]])),
    ).toMatchObject({ title: item.meta });
  });
});
