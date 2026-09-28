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
  it("keeps inactive custody outside canonical turns and their grouping boundaries", () => {
    const messages = [
      {
        role: "user",
        content: "Current question",
        timestamp: 100,
        __openclaw: { id: "question", seq: 1 },
      },
      {
        role: "assistant",
        content: "Current answer",
        timestamp: 200,
        __openclaw: { id: "answer", seq: 2 },
      },
      {
        role: "assistant",
        content: "Answer continuation",
        timestamp: 300,
        __openclaw: { id: "continuation", seq: 3 },
      },
    ];
    const pendingInputs = [
      acceptedInput("Old stopped prompt", 250, "interrupted"),
      acceptedInput("Old cancelled prompt", 400, "cancelled"),
    ];
    expect(visibleRows({ messages, pendingInputs })).toEqual([
      "Current question",
      "Current answer",
      "Answer continuation",
    ]);
    const groups = buildChatItems({
      paneId: "saved-order",
      sessionKey: "agent:main:saved-order",
      messages,
      pendingInputs,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    }).filter((item) => item.kind === "group");
    expect(
      groups.map((group) => group.messages.map(({ message }) => extractTextCached(message))),
    ).toEqual([["Current question"], ["Current answer", "Answer continuation"]]);
  });

  it.each(["steer", "interrupt"] as const)(
    "keeps consecutive sends in submission order while a %s ACK is pending",
    (queueMode) => {
      const first = { ...queuedInput("First input", 10, "sending"), queueMode };
      const second = { ...queuedInput("Second input", 20, "sending"), queueMode };
      resetChatThreadState("input-order");
      try {
        expect(visibleRows({ queue: [first] }, buildCachedChatItems)).toEqual([
          "Existing conversation",
          "First input",
        ]);
        const expected = ["Existing conversation", "First input", "Second input"];
        expect(visibleRows({ queue: [first, second] }, buildCachedChatItems)).toEqual(expected);
        // Custody can retire the successor's outbox row before the first ACK.
        expect(
          visibleRows(
            { queue: [first], pendingInputs: [acceptedInput("Second input", 30)] },
            buildCachedChatItems,
          ),
        ).toEqual(expected);
        const canonical = [first, second].map((input, index) => ({
          role: "user",
          content: input.text,
          timestamp: input.createdAt,
          __openclaw: { id: input.id, seq: index + 2, idempotencyKey: input.sendRunId },
        }));
        expect(
          visibleRows({ messages: [canonical[1]], queue: [first] }, buildCachedChatItems),
        ).toEqual(["First input", "Second input"]);
        expect(visibleRows({ messages: canonical, queue: [] }, buildCachedChatItems)).toEqual([
          "First input",
          "Second input",
        ]);
      } finally {
        resetChatThreadState("input-order");
      }
    },
  );

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
    "preserves live server order without saved $state rows with $label timestamps",
    ({ state, timestamps }) => {
      const expectedInputs =
        state === "queued" ? ["First accepted input", "Second accepted input"] : [];

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

  it("reuses loaded history when a render rebuilds its pending input list", () => {
    let messageReads = 0;
    const loaded = new Proxy(
      {
        role: "assistant",
        content: "Loaded history",
        timestamp: 1,
        __openclaw: { id: "loaded", seq: 1 },
      },
      {
        get(target, key, receiver) {
          messageReads += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const accepted = acceptedInput("Later input", 30);
    const input: BuildChatItemsProps = {
      paneId: "input-order",
      sessionKey: "agent:main:input-order",
      messages: [loaded],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    };
    resetChatThreadState("input-order");
    try {
      const first = buildCachedChatItems({ ...input, pendingInputs: [accepted] });
      messageReads = 0;
      // renderChat derives this list on every render, including scroll-driven ones.
      const next = buildCachedChatItems({ ...input, pendingInputs: [accepted] });

      expect(next).toBe(first);
      expect(messageReads).toBe(0);
    } finally {
      resetChatThreadState("input-order");
    }
  });
});
