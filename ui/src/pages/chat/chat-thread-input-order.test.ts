import { describe, expect, it } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

type PendingInput = NonNullable<BuildChatItemsProps["pendingInputs"]>[number];

function queuedInput(
  text: string,
  createdAt: number,
  sendState: ChatQueueItem["sendState"] = "submitting",
): ChatQueueItem {
  return {
    id: text,
    text,
    createdAt,
    sendRunId: text,
    sendState,
    sendAttempts: 1,
  };
}

function acceptedInput(
  text: string,
  acceptedAt: number,
  state: PendingInput["state"] = "queued",
): PendingInput {
  return {
    id: text,
    runId: text,
    acceptedAt,
    state,
    message: {
      role: "user",
      content: text,
      timestamp: acceptedAt,
      __openclaw: { id: `pending:${text}` },
    },
  };
}

function visibleRows(
  overrides: Partial<BuildChatItemsProps>,
  build = buildChatItems,
): Array<string | null> {
  return build({
    paneId: "input-order",
    sessionKey: "agent:main:input-order",
    messages: [
      {
        role: "assistant",
        content: "Existing conversation",
        timestamp: 1,
        __openclaw: { id: "earlier-answer", seq: 1 },
      },
    ],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractTextCached(message))
      : item.kind === "notice"
        ? [item.text]
        : [],
  );
}

describe("transcript input order", () => {
  it.each(["failed", "unconfirmed", "waiting-reconnect"] as const)(
    "keeps an earlier %s input ahead of a newer submitting input",
    (sendState) => {
      expect(
        visibleRows({
          queue: [queuedInput("Earlier input", 10, sendState), queuedInput("New input", 20)],
        }),
      ).toEqual(["Existing conversation", "Earlier input", "New input"]);
    },
  );

  it("keeps accepted input ahead of a new submission through its custody handoff", () => {
    const queue = [queuedInput("New input", 20)];
    const earlier = acceptedInput("Earlier input", 10);
    const expected = ["Existing conversation", "Earlier input", "New input"];

    expect([
      visibleRows({ queue, pendingInputs: [earlier] }),
      visibleRows({ queue, pendingInputs: [earlier, acceptedInput("New input", 30)] }),
    ]).toEqual([expected, expected]);
  });

  it.each(
    (["queued", "interrupted", "cancelled"] as const).flatMap((state) =>
      [
        { label: "equal", timestamps: [20, 20] as const },
        { label: "reversed", timestamps: [30, 20] as const },
      ].map((clock) => ({ state, label: clock.label, timestamps: clock.timestamps })),
    ),
  )(
    "preserves server $state input order and attached notices with $label timestamps",
    ({ state, timestamps }) => {
      const notice =
        state === "interrupted"
          ? "Interrupted before the agent started it. It will not run automatically; copy it and send again."
          : state === "cancelled"
            ? "Cancelled before the agent started it. It will not run automatically; copy it and send again."
            : null;
      const expectedInputs = ["First accepted input", "Second accepted input"].flatMap((text) =>
        notice ? [text, notice] : [text],
      );

      expect(
        visibleRows({
          pendingInputs: [
            acceptedInput("First accepted input", timestamps[0], state),
            acceptedInput("Second accepted input", timestamps[1], state),
          ],
        }),
      ).toEqual(["Existing conversation", ...expectedInputs]);
    },
  );

  it("preserves a reordered queue when its first input receives custody", () => {
    const first = { ...queuedInput("Moved first", 30), orderKey: 10 };
    const second = { ...queuedInput("Moved second", 10), orderKey: 30 };
    const queue = [first, second];
    const expected = ["Existing conversation", "Moved first", "Moved second"];

    expect([
      visibleRows({ queue }),
      visibleRows({ queue, pendingInputs: [acceptedInput("Moved first", 40)] }),
    ]).toEqual([expected, expected]);
  });

  it("keeps the displayed order while consumption retires a local custody anchor", () => {
    const earlier = queuedInput("Earlier input", 10, "failed");
    const later = queuedInput("Later input", 20);
    const pendingInputs = [acceptedInput("Later input", 30)];
    const expected = ["Existing conversation", "Earlier input", "Later input"];
    resetChatThreadState("input-order");
    try {
      for (const queue of [[earlier, later], [earlier], [{ ...earlier }]]) {
        expect(visibleRows({ queue, pendingInputs }, buildCachedChatItems)).toEqual(expected);
      }
      expect(
        visibleRows(
          {
            queue: [earlier],
            pendingInputs,
            searchOpen: true,
            searchQuery: "Earlier input",
          },
          buildCachedChatItems,
        ),
      ).toEqual(["Earlier input"]);
      expect(visibleRows({ queue: [earlier], pendingInputs }, buildCachedChatItems)).toEqual(
        expected,
      );
    } finally {
      resetChatThreadState("input-order");
    }
  });

  it.each(["followup", "steer"] as const)(
    "preserves input order when a recovered %s reply arrives before its prompt",
    (queueMode) => {
      const earlier = queuedInput("Earlier input", 10, "failed");
      const later = { ...queuedInput("Later input", 20), queueMode };
      const reply = {
        role: "assistant",
        content: "Recovered reply",
        timestamp: 30,
        __openclaw: { id: "recovered-reply", seq: 2, runId: later.sendRunId },
      };
      const canonical = {
        role: "user",
        content: later.text,
        timestamp: 20,
        __openclaw: { id: "later-input", seq: 1, idempotencyKey: `${later.sendRunId}:user` },
      };
      const expected =
        queueMode === "steer"
          ? ["Later input", "Recovered reply", "Earlier input"]
          : ["Earlier input", "Later input", "Recovered reply"];
      resetChatThreadState("input-order");
      try {
        expect(
          visibleRows({ messages: [reply], queue: [earlier, later] }, buildCachedChatItems),
        ).toEqual(expected);
        expect(
          visibleRows({ messages: [canonical, reply], queue: [earlier] }, buildCachedChatItems),
        ).toEqual(expected);
      } finally {
        resetChatThreadState("input-order");
      }
    },
  );
});
