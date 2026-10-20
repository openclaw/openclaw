/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { createTestTranscript, disposeChatView, renderChatInto } from "./chat-view.test-helpers.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { saveChatSessionScrollPosition } from "./scroll.ts";

let container: ReturnType<typeof createComposerContainer>;
let transcript: ReturnType<typeof createTestTranscript>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  installTranscriptDomMocks();
  container = createComposerContainer();
  transcript = createTestTranscript();
});
afterEach(() => {
  disposeChatView(container);
  transcript.dispose();
  resetChatViewState();
  resetTranscriptTestDom();
  vi.useRealTimers();
});

const runId = "active-run";
const user = {
  role: "user",
  content: "Read the workspace files.",
  timestamp: 1,
  __openclaw: { id: "user-request", idempotencyKey: runId + ":user" },
};

function tool(
  id: string,
  status: AgentActivityItem["status"] = "running",
  owner = runId,
  timestamp = 2,
) {
  const activity = (itemId: string, title: string, state = status): AgentActivityItem => ({
    itemId,
    toolCallId: itemId,
    kind: "tool",
    name: "read",
    title,
    status: state,
    phase: state === "running" ? "start" : "end",
  });
  return {
    role: "assistant",
    runId: owner,
    timestamp,
    __openclaw: { id: "tool-" + id, runId: owner },
    // Two cards take the expandable activity path, not the single-tool card path.
    content: [
      { type: "toolCall", id: "prior-" + id, name: "read", arguments: { path: "/repo/prior.ts" } },
      { type: "toolCall", id, name: "read", arguments: { path: "/repo/" + id + ".ts" } },
    ],
    activity: [
      activity("prior-" + id, "Prior file", "completed"),
      activity(id, `Inspect the ${id} file`),
    ],
  };
}

function labels(selector = ".chat-activity-group__label") {
  return Array.from(container.querySelectorAll(selector), (node) => node.textContent);
}

function draw(messages: unknown[], overrides: Partial<Parameters<typeof renderChatInto>[1]> = {}) {
  renderChatInto(container, {
    transcript,
    messages,
    runActive: true,
    runId,
    streamStartedAt: 1,
    ...overrides,
  });
}

it("renders current operation copy through the real transcript and retains completion between tools", () => {
  draw([user, tool("first")]);
  expect(labels()).toEqual(["Inspect the first file…"]);
  vi.advanceTimersByTime(2_000);
  draw([user, tool("first", "completed")]);
  expect(labels()).toEqual(["Inspect the first file"]);
  draw([user, tool("first", "completed"), tool("next", "running", runId, 3)]);
  expect(labels()).toEqual(["Inspect the first file"]);
  vi.advanceTimersByTime(999);
  expect(labels()).toEqual(["Inspect the first file"]);
  vi.advanceTimersByTime(1);
  flush();
  expect(labels()).toEqual(["Inspect the next file…"]);
});

it("retains live running activity when history contains an unfinished call", () => {
  const call = tool("active");
  const history = {
    ...call,
    activity: [
      call.activity[0]!,
      {
        ...call.activity[1]!,
        phase: "end",
        status: undefined,
        summary: "Outcome unknown",
        unpairedCall: true,
      },
    ] satisfies AgentActivityItem[],
  };
  const live = {
    ...tool("active"),
    __openclawToolStreamLive: true,
    __openclawToolStreamResultReceived: false,
    __openclawToolStreamItemEnded: false,
  };
  draw([user, history], { toolMessages: [live] });
  expect(labels()).toEqual(["Inspect the active file…"]);
  expect(container.textContent).not.toContain("Outcome unknown");
  expect(container.textContent).not.toContain("1 unknown");
});

it("limits live copy to the newest activity group in the active run, not history or another run", () => {
  transcript = createTestTranscript("activity-headline-history");
  saveChatSessionScrollPosition("activity-headline-history", "main", {
    scrollTop: 0,
    anchorToEnd: false,
  });
  draw(
    [
      tool("history", "completed", "old-run", 0),
      user,
      tool("earlier", "completed"),
      {
        role: "assistant",
        content: "Now inspect the next file.",
        phase: "commentary",
        runId,
        timestamp: 3,
        __openclaw: { id: "commentary", runId },
      },
      tool("latest", "running", runId, 4),
      {
        role: "user",
        content: "A separate request.",
        timestamp: 5,
        __openclaw: { id: "peer-user", idempotencyKey: "peer-run:user" },
      },
      tool("peer", "running", "peer-run", 6),
    ],
    { persistCommentary: true },
  );
  expect(labels(".chat-activity-group__label--live")).toEqual(["Inspect the latest file…"]);
  expect(labels().filter((label) => label === "2 reads")).toHaveLength(3);
});

it.each(["end", "session", "run", "connection"] as const)(
  "does not carry a pending title across a %s scope change",
  async (scope) => {
    draw([user, tool("first")]);
    vi.advanceTimersByTime(100);
    const messages = [user, tool("first", "completed"), tool("next", "running", runId, 3)];
    draw(messages);
    expect(labels()).toEqual(["Inspect the first file"]);
    if (scope === "end") {
      draw(messages, { runActive: false, runId: null });
      expect(container.querySelector(".chat-activity-group__label--live")).toBeNull();
      expect(labels()).toEqual(["4 reads"]);
      vi.advanceTimersByTime(3_000);
      expect(labels()).toEqual(["4 reads"]);
      expect(container.textContent).not.toContain("Inspect the next file…");
      return;
    }
    const owner = scope === "run" ? "replacement-run" : runId;
    draw(
      [
        { ...user, __openclaw: { ...user["__openclaw"], idempotencyKey: owner + ":user" } },
        tool("first", "completed", owner),
        tool("fresh", "running", owner, 4),
      ],
      {
        runId: owner,
        ...(scope === "session" ? { sessionKey: "agent:main:other" } : {}),
        ...(scope === "connection" ? { connectionEpoch: 2 } : {}),
      },
    );
    await waitForSolid(() => expect(labels()).toEqual(["Inspect the fresh file…"]));
    vi.advanceTimersByTime(3_000);
    expect(labels()).toEqual(["Inspect the fresh file…"]);
  },
);
