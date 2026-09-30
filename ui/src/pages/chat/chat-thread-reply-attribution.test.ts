// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import {
  localParticipantIdentityKey,
  sessionParticipantIdentityKey,
} from "../../lib/chat/sender-label.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

type Props = Parameters<typeof buildCachedChatItems>[0];
function createProps(overrides: Partial<Props> = {}): Props {
  return {
    paneId: "reply-attribution",
    sessionKey: "main",
    runId: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}
function userMessage(content: string, timestamp: number, overrides: Record<string, unknown> = {}) {
  return { role: "user", content, timestamp, ...overrides };
}
function assistantMessage(
  content: string,
  timestamp: number,
  overrides: Record<string, unknown> = {},
) {
  return { role: "assistant", content, timestamp, ...overrides };
}
function messageGroups(props: Partial<Props>) {
  return buildCachedChatItems(createProps(props)).filter((item) => item.kind === "group");
}
beforeEach(() => resetChatThreadState());
describe("reply attribution grouping", () => {
  it.each([
    { boundary: "sender-less user", message: userMessage("Local follow-up", 1006) },
    {
      boundary: "system turn",
      message: userMessage("[System] Scheduled report", 1006, {
        provenance: { kind: "internal_system", sourceTool: "cron" },
        __openclaw: { idempotencyKey: "system-run:user" },
      }),
    },
    {
      boundary: "forwarded input",
      message: assistantMessage("Forwarded input", 1006, {
        senderSession: { sessionKey: "agent:other:main" },
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
    },
  ])("attributes the latest prompt and clears it at $boundary", ({ message }) => {
    const alice = userMessage("Alice asks", 1000, {
      __openclaw: { senderId: "alice", senderName: "Alice" },
    });
    const followUp = userMessage("Bob follows up", 1003, {
      __openclaw: { senderId: "bob", senderName: "Bob" },
    });
    const groups = messageGroups({
      messages: [
        alice,
        assistantMessage("For Alice", 1001),
        userMessage("Bob asks", 1002, {
          __openclaw: { senderId: "bob", senderName: "Bob" },
        }),
        followUp,
        assistantMessage("For Bob", 1004),
        message,
        assistantMessage("After boundary", 1007),
      ],
    });

    const assistantGroups = groups.filter((group) => group.role === "assistant");
    expect(assistantGroups[0]).toMatchObject({
      replyToSender: { id: "alice", name: "Alice" },
      replyToMessage: { message: alice },
    });
    const bobGroup = groups.find((group) => group.role === "user" && group.sender?.id === "bob");
    expect(bobGroup?.messages).toHaveLength(2);
    expect(assistantGroups[1]).toMatchObject({
      replyToSender: { id: "bob", name: "Bob" },
      replyToMessage: { message: followUp, key: bobGroup?.messages.at(-1)?.key },
    });
    expect(assistantGroups.at(-1)?.replyToSender).toBeUndefined();
    expect(assistantGroups.at(-1)?.replyToMessage).toBeUndefined();
  });

  it.each([
    {
      boundary: "human prompt",
      message: userMessage("Status?", 1002, {
        __openclaw: { senderId: "bob", senderName: "Bob" },
      }),
      recipient: "Bob",
    },
    {
      boundary: "forwarded input",
      message: assistantMessage("Forwarded report", 1002, {
        senderLabel: "Forwarded from main",
        provenance: { kind: "inter_session", sourceTool: "sessions_send" },
      }),
      recipient: undefined,
    },
    {
      boundary: "projected forwarded source",
      message: assistantMessage("Forwarded report", 1002, {
        senderSession: { sessionKey: "agent:other:main", agentId: "other" },
      }),
      recipient: undefined,
    },
    {
      boundary: "cron delivery",
      message: assistantMessage("Scheduled report", 1002, {
        senderLabel: "Daily report",
        provenance: {
          kind: "internal_system",
          sourceTool: "cron",
          jobId: "daily",
          runId: "cron-run",
          sourceSessionKey: "agent:main:cron:daily",
        },
      }),
      recipient: undefined,
    },
    {
      boundary: "projected turn",
      message: assistantMessage("Automatic continuation", 1002, {
        __openclaw: { turnBoundary: true },
      }),
      recipient: undefined,
    },
  ])("keeps search hits apart across a hidden $boundary", ({ message, recipient }) => {
    const groups = messageGroups({
      searchOpen: true,
      searchQuery: "Rollout",
      replyPeople: [
        sessionParticipantIdentityKey({ type: "profile", id: "alice" }),
        sessionParticipantIdentityKey({ type: "profile", id: "bob" }),
      ],
      messages: [
        userMessage("Deploy?", 1000, { __openclaw: { senderId: "alice", senderName: "Alice" } }),
        assistantMessage("Rollout started", 1001),
        message,
        assistantMessage("Rollout done", 1003),
      ],
    });

    expect(groups.map((group) => [group.messages.length, group.replyToSender?.name])).toEqual([
      [1, "Alice"],
      [1, recipient],
    ]);
  });

  it.each(["human", "forwarded", "projected source"] as const)(
    "keeps tool results out of the previous turn when search hides a %s boundary",
    (boundary) => {
      const invocation = {
        role: "assistant",
        content: [
          { type: "text", text: "Rollout started" },
          { type: "tool_call", id: "reused", name: "custom", arguments: {} },
        ],
        timestamp: 1000,
      };
      const separator =
        boundary === "human"
          ? userMessage("New request", 1001)
          : assistantMessage(
              "Forwarded request",
              1001,
              boundary === "forwarded"
                ? { provenance: { kind: "inter_session", sourceTool: "sessions_send" } }
                : { senderSession: { sessionKey: "agent:other:main", agentId: "other" } },
            );
      const result = {
        role: "toolResult",
        toolCallId: "reused",
        toolName: "custom",
        content: "Rollout result from the later turn",
        timestamp: 1002,
      };
      const sources = messageGroups({
        messages: [invocation, separator, result],
        searchOpen: true,
        searchQuery: "Rollout",
      }).flatMap((group) => group.messages);
      expect(sources.map((source) => source.message)).toEqual([invocation, result]);
    },
  );

  it("retains a search-hidden historical pending input as the reply source", () => {
    const prompt = userMessage("Please resume", 1002, {
      __openclaw: { id: "pending:bob", senderId: "bob", senderName: "Bob" },
    });
    const groups = messageGroups({
      searchOpen: true,
      searchQuery: "Rollout",
      messages: [
        userMessage("Rollout plan?", 1000, {
          __openclaw: { senderId: "alice", senderName: "Alice" },
        }),
        assistantMessage("Rollout started", 1001),
        assistantMessage("Rollout resumed", 1003),
      ],
      pendingInputs: [{ id: "bob", acceptedAt: 1002, state: "interrupted", message: prompt }],
    });
    const replies = groups.filter((group) => group.role === "assistant");
    expect(replies.map((group) => [group.messages.length, group.replyToSender?.name])).toEqual([
      [1, "Alice"],
      [1, "Bob"],
    ]);
    expect(replies[1]?.replyTurnSource?.message).toBe(prompt);
    expect(groups.some((group) => group.messages.some((source) => source.message === prompt))).toBe(
      false,
    );
  });

  it("keeps a search-hidden local prompt before its recovered output without inheriting a peer", () => {
    const groups = messageGroups({
      searchOpen: true,
      searchQuery: "Rollout",
      replyLocalPerson: localParticipantIdentityKey("viewer"),
      messages: [
        userMessage("Rollout plan?", 1000, {
          __openclaw: { senderId: "bob", senderName: "Bob" },
        }),
        assistantMessage("Rollout started", 1001),
        assistantMessage("Rollout resumed", 1003, {
          __openclaw: { id: "recovered", seq: 3, runId: "local-run" },
        }),
      ],
      queue: [
        {
          id: "local",
          text: "Please resume",
          createdAt: 1002,
          sendRunId: "local-run",
          sendState: "waiting-reconnect",
          sendAttempts: 1,
        },
      ],
    });
    const replies = groups.filter((group) => group.role === "assistant");
    expect(replies.map((group) => group.replyToSender?.name)).toEqual(["Bob", undefined]);
    expect(replies[1]?.replyShared).toBe(true);
    expect(replies[1]?.replyTurnSource?.key).toBe("msg:send:local-run:0");
  });

  it.each([false, true])(
    "keeps live attribution before a future pending input (search: %s)",
    (searchOpen) => {
      const current = userMessage("Current prompt", 1000, {
        __openclaw: { id: "pending:current", senderId: "bob", senderName: "Bob" },
      });
      const future = userMessage("Rollout follow-up", 1001, {
        __openclaw: { id: "pending:future", senderId: "alice", senderName: "Alice" },
      });
      const items = buildCachedChatItems(
        createProps({
          searchOpen,
          searchQuery: "Rollout",
          runId: "current",
          stream: "Rollout in progress",
          streamStartedAt: 1002,
          pendingInputs: [
            {
              id: "current",
              runId: "current",
              acceptedAt: 1000,
              state: "queued",
              message: current,
            },
            { id: "future", runId: "future", acceptedAt: 1001, state: "queued", message: future },
          ],
        }),
      );
      const streamIndex = items.findIndex((item) => item.kind === "stream");
      const futureIndex = items.findIndex(
        (item) =>
          item.kind === "group" && item.messages.some((source) => source.message === future),
      );
      expect(streamIndex).toBeGreaterThanOrEqual(0);
      expect(streamIndex).toBeLessThan(futureIndex);
      const stream = items[streamIndex];
      expect(stream).toMatchObject({ replyToSender: { name: "Bob" } });
      expect(stream?.kind === "stream" && stream.replyToMessage?.message).toBe(current);
    },
  );

  it("does not add reply attribution in a single-sender thread", () => {
    const groups = messageGroups({
      messages: [
        userMessage("Alice asks", 1000, {
          __openclaw: { senderId: "alice", senderName: "Alice" },
        }),
        assistantMessage("For Alice", 1001),
      ],
    });

    const assistant = groups.find((group) => group.role === "assistant");
    expect(assistant?.replyToSender).toBeUndefined();
    expect(assistant?.replyToMessage).toBeUndefined();
    expect(assistant?.replyShared).toBeUndefined();
    expect(assistant?.replyTurnSource?.message).toMatchObject({ content: "Alice asks" });
  });

  it("marks own user replies as shared once several people speak", () => {
    const groups = messageGroups({
      messages: [
        userMessage("Alice asks", 1000, {
          __openclaw: { senderId: "alice", senderName: "Alice" },
        }),
        userMessage("Bob asks", 1001, { __openclaw: { senderId: "bob", senderName: "Bob" } }),
        assistantMessage("For Bob", 1002),
      ],
    });

    expect(groups.map((group) => [group.role, group.replyShared])).toEqual([
      ["user", true],
      ["user", true],
      ["assistant", true],
    ]);
  });

  it.each([
    {
      case: "a listed profile's legacy messages",
      people: [sessionParticipantIdentityKey({ type: "profile", id: "alice" })],
      senders: [{ senderId: "alice", senderName: "Alice" }],
      shared: undefined,
    },
    {
      case: "an untyped sender whose name changes",
      people: [],
      senders: [
        { senderId: "alice", senderName: "Alice" },
        { senderId: "alice", senderName: "Alice Liddell", senderUsername: "al" },
      ],
      shared: undefined,
    },
    {
      case: "a typed profile after its own untyped messages",
      people: [],
      senders: [
        { senderId: "alice", senderName: "Alice" },
        { senderId: "alice", senderIdentity: { type: "profile", id: "alice" } },
      ],
      shared: undefined,
    },
    {
      case: "two untyped senders",
      people: [sessionParticipantIdentityKey({ type: "profile", id: "alice" })],
      senders: [
        { senderId: "alice", senderName: "Alice" },
        { senderId: "bob", senderName: "Bob" },
      ],
      shared: true,
    },
  ])("counts people by stable sender id: $case", ({ people, senders, shared }) => {
    const groups = messageGroups({
      replyPeople: people,
      messages: senders.flatMap((sender, index) => [
        userMessage(`Ask ${index}`, index * 2, { __openclaw: sender }),
        assistantMessage(`Answer ${index}`, index * 2 + 1),
      ]),
    });

    expect(groups.map((group) => group.replyShared)).toEqual(groups.map(() => shared));
  });

  it.each([
    { peer: "bob", shared: true },
    { peer: "viewer", shared: undefined },
  ])(
    "counts local sender-less prompts as the signed-in viewer (attributed: $peer)",
    ({ peer, shared }) => {
      // The session row lists only its owner; the viewer's own prompts carry no sender.
      const viewer = localParticipantIdentityKey("viewer");
      const attributed = userMessage("Status?", 1002, {
        __openclaw: {
          senderId: peer,
          senderName: peer,
          senderIdentity: { type: "profile", id: peer },
        },
      });
      const groups = messageGroups({
        replyPeople: [viewer],
        replyLocalPerson: viewer,
        messages: [
          userMessage("Deploy?", 1000),
          assistantMessage("Deploying", 1001),
          attributed,
          assistantMessage("Rollout done", 1003),
        ],
      });

      const [first, last] = groups.filter((group) => group.role === "assistant");
      expect(last?.replyShared).toBe(shared);
      expect(last?.replyToMessage?.message).toBe(shared ? attributed : undefined);
      // The local prompt counts as a person but never names its reply.
      expect(first?.replyToSender).toBeUndefined();
    },
  );

  it.each([
    { first: null, second: "older", groups: 2 },
    { first: "older", second: "newer", groups: 2 },
    { first: "current", second: "older", groups: 2 },
    { first: "older", second: "older", groups: 1 },
  ])("keeps attribution boundaries from $first to $second", ({ first, second, groups }) => {
    const messages = [first, second].map((target, index) =>
      assistantMessage(
        `Reply ${index}`,
        index + 1,
        target === "current"
          ? { openclawDelivery: { replyToCurrent: true } }
          : target
            ? { __openclaw: { replyToId: target } }
            : {},
      ),
    );
    const items = groupMessages(
      messages.map((message, index) => ({ kind: "message", key: `reply:${index}`, message })),
    );
    expect(items).toHaveLength(groups);
    expect(
      items.filter((item) => item.kind === "group").map((group) => group.messages.length),
    ).toEqual(groups === 1 ? [2] : [1, 1]);
  });

  it.each([
    {
      changed: "sender provenance",
      text: "second",
      name: "Bobby",
      avatar: "/api/users/bob/avatar?v=2",
    },
    { changed: "prompt content", text: "updated prompt", name: "Bob", avatar: undefined },
  ])("$changed refreshes attribution on an unchanged assistant reply", ({ text, name, avatar }) => {
    const alice = userMessage("first", 1, {
      __openclaw: {
        senderId: "alice",
        senderName: "Alice",
        senderIdentity: { type: "profile", id: "alice" },
      },
    });
    const bob = userMessage("second", 2, {
      __openclaw: {
        id: "bob-prompt",
        senderId: "bob",
        senderName: "Bob",
        senderIdentity: { type: "profile", id: "bob" },
      },
    });
    const reply = assistantMessage("answer", 3);
    const input = createProps({ messages: [alice, bob, reply] });
    const original = buildCachedChatItems(input).find(
      (item) => item.kind === "group" && item.role === "assistant",
    );
    const replacement = userMessage(text, 2, {
      __openclaw: {
        id: "bob-prompt",
        senderId: "bob",
        senderName: name,
        senderIdentity: { type: "profile", id: "bob" },
        ...(avatar ? { senderProfileAvatarUrl: avatar } : {}),
      },
    });
    const updated = buildCachedChatItems({ ...input, messages: [alice, replacement, reply] }).find(
      (item) => item.kind === "group" && item.role === "assistant",
    );
    expect(updated).toMatchObject({
      replyToSender: { name, ...(avatar ? { profileAvatarUrl: avatar } : {}) },
    });
    expect(updated?.kind === "group" && updated.replyToMessage?.message).toBe(replacement);
    expect(updated?.kind === "group" && updated.replyToMessage?.key).toBe(
      original?.kind === "group" ? original.replyToMessage?.key : undefined,
    );
  });
});
