// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import {
  HARNESS_UPDATE_REQUIRED_CODE,
  type RunFailureCause,
} from "../../../../src/shared/run-failure-notice.js";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { projectRunFailureStreaks } from "./chat-run-failure-streaks.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { buildItems, createProps } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";

beforeEach(() => resetChatThreadState());

const summary = "Rate-limit recovery stopped";
type Notice = Extract<ChatItem, { kind: "notice" }>;
const failure = (runId: string, text = summary, cause?: RunFailureCause): Notice => ({
  kind: "notice",
  key: `failure:${runId}`,
  text,
  timestamp: 1,
  runError: { runId, summary: text, cause: structuredClone(cause) },
});
const message = (key: string, value: unknown): ChatItem => ({
  kind: "message",
  key,
  message: value,
});
const internalUpdate = (kind: string) =>
  message(kind, { role: "user", content: "Update", provenance: { kind } });
const persistedFailure = (runId: string, seq: number) => ({
  role: "custom",
  content: summary,
  timestamp: seq,
  openclawRunError: { runId, summary },
});

const billingCause = {
  provider: "google",
  failoverReason: "billing",
  billingError: { message: "Upgrade your plan", actionUrl: "https://example.com/plans" },
} satisfies RunFailureCause;

it.each([
  ["provider", { ...billingCause, provider: "other-provider" }],
  ["reason", { ...billingCause, failoverReason: "auth" }],
  [
    "billing message",
    { ...billingCause, billingError: { ...billingCause.billingError, message: "Add credits" } },
  ],
  [
    "action URL",
    {
      ...billingCause,
      billingError: { ...billingCause.billingError, actionUrl: "https://example.com/credits" },
    },
  ],
  ["missing action URL", { ...billingCause, billingError: { message: "Upgrade your plan" } }],
  ["missing billing details", { provider: "google", failoverReason: "billing" }],
  ["harness update action", { ...billingCause, code: HARNESS_UPDATE_REQUIRED_CODE }],
  ["missing cause", undefined],
] satisfies Array<[string, RunFailureCause | undefined]>)(
  "preserves distinct recovery notices in the chat projection: %s",
  (_reason, cause) => {
    const errors = [
      { runId: "first", summary, cause: billingCause },
      { runId: "latest", summary, cause },
    ];
    const notices = buildChatItems(
      createProps({
        messages: errors.map((openclawRunError, index) => ({
          ...persistedFailure(openclawRunError.runId, index + 1),
          openclawRunError,
        })),
      }),
    ).filter((item) => item.kind === "notice" && item.runError);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ runError: errors[0] });
    expect(notices[1]).toMatchObject({ runError: { runId: "latest" } });
    for (const notice of notices) {
      expect(notice).not.toHaveProperty("repeatCount");
    }
  },
);

it.each([undefined, billingCause])(
  "keeps the latest identical recovery details across internal updates: %j",
  (cause) => {
    const first = { ...failure("first", summary, cause), repeatCount: 2 };
    const latest = failure("latest", summary, cause);
    const updates: ChatItem[] = [
      internalUpdate("inter_session"),
      internalUpdate("internal_system"),
      message("tool", {
        role: "user",
        content: [{ type: "tool_result", content: "Interrupted" }],
        stopReason: "aborted",
      }),
      message("partial", { role: "assistant", content: "Partial response", stopReason: "aborted" }),
      { kind: "notice", key: "system", text: "System update", timestamp: 1, startsTurn: true },
      { kind: "divider", key: "divider", label: "System", timestamp: 1 },
    ];
    const items = [
      first,
      ...updates.slice(0, 2),
      failure("middle", summary, cause),
      ...updates.slice(2),
      latest,
    ];
    expect(projectRunFailureStreaks(items)).toEqual([...updates, { ...latest, repeatCount: 4 }]);
    expect(first.repeatCount).toBe(2);
    expect(latest).not.toHaveProperty("repeatCount");
  },
);

it.each([
  ["real user input", message("user", { role: "USER", content: "Try once more" })],
  ["a changed summary", failure("different", "Rate-limit recovery stopped ")],
] as const)("starts a new streak after %s", (_reason, boundary) => {
  const items = [failure("first"), boundary, failure("latest")];
  expect(projectRunFailureStreaks(items)).toEqual(items);
});

it.each([false, true])(
  "collapses failure streaks before search hides user boundaries (search: %s)",
  (searchOpen) => {
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
  const cachedFailure = (runId: string, seq: number) => ({
    ...persistedFailure(runId, seq),
    __openclaw: { id: runId, seq },
  });
  const latest = cachedFailure("latest", 2);
  const notices = (messages: unknown[]) =>
    buildItems({ messages }).filter((item) => item.kind === "notice" && item.runError);
  expect(notices([latest])).toMatchObject([{ runError: { runId: "latest" } }]);
  expect(notices([cachedFailure("older", 1), latest])).toMatchObject([
    { runError: { runId: "latest" }, repeatCount: 2 },
  ]);
});
