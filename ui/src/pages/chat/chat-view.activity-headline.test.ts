/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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
  title: string,
  status: AgentActivityItem["status"] = "running",
  owner = runId,
  timestamp = 2,
) {
  const calls = ["prior-" + id, id];
  return {
    role: "assistant",
    runId: owner,
    timestamp,
    __openclaw: { id: "tool-" + id, runId: owner },
    // Two cards take the expandable activity path, not the single-tool card path.
    content: calls.map((callId, index) => ({
      type: "toolCall",
      id: callId,
      name: "read",
      arguments: { path: "/repo/" + (index ? id : "prior") + ".ts" },
    })),
    activity: calls.map((callId, index): AgentActivityItem => ({
      itemId: callId,
      toolCallId: callId,
      kind: "tool",
      name: "read",
      title: index ? title : "Prior file",
      status: index ? status : "completed",
      phase: index && status === "running" ? "start" : "end",
    })),
  };
}

const texts = (selector: string) =>
  Array.from(container.querySelectorAll(selector), (node) => node.textContent);
const labels = () => texts(".chat-activity-group__label");
const expectLabels = (expected: string[]) => expect(labels()).toEqual(expected);
const first = (status: AgentActivityItem["status"] = "running") =>
  tool("first", "Inspect the first file", status);

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

it("limits live copy to the newest activity group in the active run, not history or another run", async () => {
  transcript = createTestTranscript("activity-headline-history");
  saveChatSessionScrollPosition("activity-headline-history", "main", {
    scrollTop: 0,
    anchorToEnd: false,
  });
  draw(
    [
      tool("history", "Historical file", "completed", "old-run", 0),
      user,
      tool("earlier", "Earlier active file", "completed"),
      {
        role: "assistant",
        content: "Now inspect the next file.",
        phase: "commentary",
        runId,
        timestamp: 3,
        __openclaw: { id: "commentary", runId },
      },
      tool("latest", "Latest active file", "running", runId, 4),
      {
        role: "user",
        content: "A separate request.",
        timestamp: 5,
        __openclaw: { id: "peer-user", idempotencyKey: "peer-run:user" },
      },
      tool("peer", "Peer run file", "running", "peer-run", 6),
    ],
    { persistCommentary: true },
  );
  await waitForSolid(() =>
    expect(texts(".chat-activity-group__label--live")).toEqual(["Latest active file…"]),
  );
  expect(labels().filter((label) => label === "2 reads")).toHaveLength(3);
});

it.each(["end", "session", "run", "connection"] as const)(
  "does not carry a pending title across a %s scope change",
  async (scope) => {
    draw([user, first()]);
    await waitForSolid(() => expectLabels(["Inspect the first file…"]));
    vi.advanceTimersByTime(100);
    const messages = [
      user,
      first("completed"),
      tool("next", "Stale pending file", "running", runId, 3),
    ];
    draw(messages);
    expectLabels(["Inspect the first file"]);
    if (scope === "end") {
      draw(messages, { runActive: false, runId: null });
      expect(container.querySelector(".chat-activity-group__label--live")).toBeNull();
      expectLabels(["4 reads"]);
      vi.advanceTimersByTime(3_000);
      expectLabels(["4 reads"]);
      expect(container.textContent).not.toContain("Stale pending file…");
      return;
    }
    const owner = scope === "run" ? "replacement-run" : runId;
    draw(
      [
        { ...user, __openclaw: { ...user["__openclaw"], idempotencyKey: owner + ":user" } },
        tool("first", "Inspect the first file", "completed", owner),
        tool("fresh", "Fresh scope file", "running", owner, 4),
      ],
      {
        runId: owner,
        ...(scope === "session" ? { sessionKey: "agent:main:other" } : {}),
        ...(scope === "connection" ? { connectionEpoch: 2 } : {}),
      },
    );
    await waitForSolid(() => expectLabels(["Fresh scope file…"]));
    vi.advanceTimersByTime(3_000);
    expectLabels(["Fresh scope file…"]);
  },
);
