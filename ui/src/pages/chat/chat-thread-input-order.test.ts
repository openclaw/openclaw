import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { createProps } from "./chat-thread.test-support.ts";
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

function createInput(overrides: Partial<BuildChatItemsProps>): BuildChatItemsProps {
  return createProps({
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
    ...overrides,
  });
}

function visibleRows(
  overrides: Partial<BuildChatItemsProps>,
  build: (input: BuildChatItemsProps) => ReturnType<typeof buildChatItems> = buildChatItems,
): Array<string | null> {
  return build(createInput(overrides)).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractTextCached(message))
      : item.kind === "notice" || item.kind === "stream"
        ? [item.text]
        : [],
  );
}

beforeEach(() => resetChatThreadState("input-order"));
afterEach(() => resetChatThreadState("input-order"));

describe("transcript input order", () => {
  it("keeps accepted steers at their transcript positions between same-run answers", () => {
    const messages = [
      { role: "user", content: "Original", __openclaw: { idempotencyKey: "run:user", seq: 1 } },
      { role: "assistant", content: "Before", __openclaw: { runId: "run", seq: 2 } },
      { role: "user", content: "Steer one", __openclaw: { steerTargetRunId: "run", seq: 3 } },
      { role: "assistant", content: "After", __openclaw: { runId: "run", seq: 4 } },
      { role: "user", content: "Steer two", __openclaw: { steerTargetRunId: "run", seq: 5 } },
      { role: "assistant", content: "Final", __openclaw: { runId: "run", seq: 6 } },
      { role: "user", content: "Next", __openclaw: { idempotencyKey: "next:user", seq: 7 } },
      { role: "assistant", content: "Other run", __openclaw: { runId: "next", seq: 8 } },
    ];
    expect(visibleRows({ messages })).toEqual([
      "Original",
      "Before",
      "Steer one",
      "After",
      "Steer two",
      "Final",
      "Next",
      "Other run",
    ]);
    expect(messages.map((message) => message.content)).toEqual([
      "Original",
      "Before",
      "Steer one",
      "After",
      "Steer two",
      "Final",
      "Next",
      "Other run",
    ]);
  });

  it.each([true, false])(
    "keeps the live tail after accepted steers and before a later turn (original=%s)",
    (includeOriginal) => {
      const original = {
        role: "user",
        content: "Original",
        __openclaw: { idempotencyKey: "run:user", seq: 1 },
      };
      const messages = [
        ...(includeOriginal ? [original] : []),
        { role: "assistant", content: "Before", __openclaw: { runId: "run", seq: 2 } },
        {
          role: "user",
          content: "Steer one",
          __openclaw: { idempotencyKey: "steer-one:user", steerTargetRunId: "run", seq: 3 },
        },
        { role: "assistant", content: "After", __openclaw: { runId: "run", seq: 4 } },
        {
          role: "user",
          content: "Steer two",
          __openclaw: { idempotencyKey: "steer-two:user", steerTargetRunId: "run", seq: 5 },
        },
        { role: "user", content: "Next turn", __openclaw: { idempotencyKey: "next:user", seq: 6 } },
      ];
      expect(
        visibleRows({ messages, runId: "run", stream: "Live continuation", streamStartedAt: 1 }),
      ).toEqual([
        ...(includeOriginal ? ["Original"] : []),
        "Before",
        "Steer one",
        "After",
        "Steer two",
        "Live continuation",
        "Next turn",
      ]);
    },
  );

  it("keeps retained activity before a steer when its observed prompt is paged out", () => {
    expect(
      visibleRows({
        runId: "run",
        messages: [
          {
            role: "user",
            content: "Steer",
            __openclaw: { idempotencyKey: "steer:user", steerTargetRunId: "run", seq: 3 },
          },
        ],
        streamSegments: [
          {
            text: "Earlier commentary",
            itemId: "comment",
            runId: "run",
            ts: 9000,
            afterUserSendId: "original",
          },
        ],
        toolMessages: [
          {
            role: "assistant",
            content: "Earlier tool",
            runId: "run",
            timestamp: 9001,
            openclawToolStreamAfterSendId: "original",
          },
        ],
      }),
    ).toEqual(["Earlier commentary", "Earlier tool", "Steer"]);
  });

  it.each(["steer", "interrupt"] as const)(
    "keeps consecutive sends in submission order while a %s ACK is pending",
    (queueMode) => {
      const first = { ...queuedInput("First input", 10, "sending"), queueMode };
      const second = { ...queuedInput("Second input", 20, "sending"), queueMode };
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
      expect(
        visibleRows({ messages: [canonical[1]], queue: [first] }, (input) =>
          buildCachedChatItems(input, "unfiltered"),
        ),
      ).toEqual(["First input", "Second input"]);
      expect(visibleRows({ messages: canonical, queue: [] }, buildCachedChatItems)).toEqual([
        "First input",
        "Second input",
      ]);
    },
  );

  it.each(["unconfirmed", "waiting-reconnect", "accepted", "reordered"] as const)(
    "keeps an earlier %s input ahead of a new submission through custody",
    (state) => {
      const reordered = state === "reordered";
      const earlier = queuedInput(
        "Earlier input",
        reordered ? 30 : 10,
        state === "unconfirmed" || state === "waiting-reconnect" ? state : "submitting",
      );
      const later = queuedInput("New input", reordered ? 10 : 20);
      const queue =
        state === "accepted"
          ? [later]
          : reordered
            ? [
                { ...earlier, orderKey: 10 },
                { ...later, orderKey: 30 },
              ]
            : [earlier, later];
      const pendingInputs = state === "accepted" ? [acceptedInput("Earlier input", 10)] : [];
      const expected = ["Existing conversation", "Earlier input", "New input"];
      expect(visibleRows({ queue, pendingInputs })).toEqual(expected);
      if (state === "accepted" || reordered) {
        expect(
          visibleRows({
            queue,
            pendingInputs: [
              ...pendingInputs,
              acceptedInput(reordered ? "Earlier input" : "New input", reordered ? 40 : 30),
            ],
          }),
        ).toEqual(expected);
      }
    },
  );

  it.each([
    { state: "queued", label: "reversed", timestamps: [30, 20] },
    { state: "interrupted", label: "reversed", timestamps: [30, 20] },
    { state: "cancelled", label: "equal", timestamps: [20, 20] },
  ] as const)(
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

  it("keeps the displayed order while consumption retires a local custody anchor", () => {
    const earlier = queuedInput("Earlier input", 10, "failed");
    const later = queuedInput("Later input", 20);
    const pendingInputs = [acceptedInput("Later input", 30)];
    const expected = ["Existing conversation", "Earlier input", "Later input"];
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
      expect(
        visibleRows({ messages: [reply], queue: [earlier, later] }, buildCachedChatItems),
      ).toEqual(expected);
      expect(
        visibleRows({ messages: [canonical, reply], queue: [earlier] }, buildCachedChatItems),
      ).toEqual(expected);
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
    const input = createInput({ messages: [loaded] });
    const first = buildCachedChatItems({ ...input, pendingInputs: [accepted] });
    messageReads = 0;
    // renderChat derives this list on every render, including scroll-driven ones.
    const next = buildCachedChatItems({ ...input, pendingInputs: [accepted] });

    expect(next).toBe(first);
    expect(messageReads).toBe(0);
  });
});
