// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { projectRunFailureStreaks } from "./chat-run-failure-streaks.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { buildItems, createProps } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());

type Notice = Extract<ChatItem, { kind: "notice" }>;
const failure = (runId: string, summary = "Rate-limit recovery stopped"): Notice => ({
  kind: "notice",
  key: `failure:${runId}`,
  text: summary,
  timestamp: 1,
  runError: { runId, summary },
});
const message = (key: string, value: unknown): ChatItem => ({
  kind: "message",
  key,
  message: value,
});

it("keeps only the latest identical failure across internal updates and interrupted output", () => {
  const first = failure("first");
  const latest = failure("latest");
  const updates: ChatItem[] = [
    message("agent-update", {
      role: "user",
      content: "Agent update",
      provenance: { kind: "inter_session" },
    }),
    message("internal", {
      role: "user",
      content: "Retry prompt",
      provenance: { kind: "internal_system" },
    }),
    message("tool", {
      role: "user",
      content: [{ type: "tool_result", content: "Interrupted" }],
      stopReason: "aborted",
    }),
    message("partial", { role: "assistant", content: "Partial response", stopReason: "aborted" }),
    { kind: "notice", key: "system", text: "System update", timestamp: 1, startsTurn: true },
    { kind: "divider", key: "divider", label: "System", timestamp: 1 },
  ];
  const items = [first, ...updates.slice(0, 2), failure("middle"), ...updates.slice(2), latest];
  expect(projectRunFailureStreaks(items)).toEqual([...updates, { ...latest, repeatCount: 3 }]);
  expect(first).not.toHaveProperty("repeatCount");
  expect(latest).not.toHaveProperty("repeatCount");
});

it("keeps both failures when real user input breaks the streak", () => {
  const items = [
    failure("first"),
    message("user", { role: "USER", content: "Try once more" }),
    failure("latest"),
  ];
  expect(projectRunFailureStreaks(items)).toEqual(items);
});

it("starts a new streak whenever the exact summary changes", () => {
  const items = [
    failure("first"),
    failure("different", "Rate-limit recovery stopped "),
    failure("latest"),
  ];
  expect(projectRunFailureStreaks(items)).toEqual(items);
});

it.each([false, true])(
  "collapses failure streaks before search hides user boundaries (search: %s)",
  (searchOpen) => {
    const summary = "Rate-limit recovery stopped";
    const persistedFailure = (runId: string, timestamp: number) => ({
      role: "custom",
      content: summary,
      timestamp,
      openclawRunError: { runId, summary },
    });
    const items = buildChatItems(
      createProps({
        messages: [
          persistedFailure("first", 1),
          {
            role: "user",
            content: "Automation wake",
            timestamp: 2,
            provenance: { kind: "internal_system" },
          },
          persistedFailure("second", 3),
          { role: "user", content: "Try once more", timestamp: 4 },
          persistedFailure("third", 5),
        ],
        searchOpen,
        searchQuery: searchOpen ? summary : "",
      }),
    );
    expect(items.filter((item) => item.kind === "notice" && item.runError)).toMatchObject([
      { runError: { runId: "second" }, repeatCount: 2 },
      { runError: { runId: "third" } },
    ]);
  },
);

it("updates a cached failure's repeat count when older history loads", () => {
  const summary = "Rate-limit recovery stopped";
  const persistedFailure = (runId: string, seq: number) => ({
    role: "custom",
    content: summary,
    timestamp: seq,
    openclawRunError: { runId, summary },
    __openclaw: { id: runId, seq },
  });
  const latest = persistedFailure("latest", 2);
  const notices = (messages: unknown[]) =>
    buildItems({ messages }).filter((item) => item.kind === "notice" && item.runError);
  expect(notices([latest])).toMatchObject([{ runError: { runId: "latest" } }]);
  expect(notices([persistedFailure("older", 1), latest])).toMatchObject([
    { runError: { runId: "latest" }, repeatCount: 2 },
  ]);
});
