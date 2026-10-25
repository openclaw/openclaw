// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import {
  localParticipantIdentityKey,
  sessionParticipantIdentityKey,
} from "../../lib/chat/sender-label.ts";
import {
  message as chatMessage,
  nativeMessage,
  person,
  queued,
  toolResult,
} from "./chat-thread-fixtures.test-support.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildItems, createProps, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";

type Fields = Record<string, unknown>;
const assistantMessage = (content: unknown, timestamp: number, fields: Fields = {}) =>
  chatMessage("assistant", content, timestamp, fields);
function prompt(
  id: string,
  timestamp: number,
  metadata: Fields = {},
  content = `${id} ${timestamp}`,
) {
  return nativeMessage("user", content, timestamp, sender(id, metadata));
}
function observedSender(accountId: string, reversed = false) {
  const identity = {
    type: "observation",
    pluginId: "slack",
    accountId,
    senderKind: "human",
    id: "alice",
  };
  const senderIdentity = reversed
    ? Object.fromEntries(Object.entries(identity).toReversed())
    : identity;
  return { senderId: "alice", senderIdentity };
}
function queuedPrompt(id: string, message: Record<string, unknown>, acceptedAt: number) {
  return { id, runId: id, acceptedAt, state: "queued" as const, message };
}
function boundary(label: string, searchOpen: boolean, fields: Fields, recipient?: string) {
  return {
    boundary: label,
    searchOpen,
    recipient,
    message: { role: "assistant", content: label, timestamp: searchOpen ? 1002 : 1006, ...fields },
  };
}
function sender(senderId = "alice", fields: Fields = {}) {
  return { senderId, senderName: senderId === "alice" ? "Alice" : "Bob", ...fields };
}
const profileKey = (id: string) => sessionParticipantIdentityKey({ type: "profile", id });
function messageGroups(props: Partial<CachedChatItemsProps>) {
  return buildItems(props).filter((item) => item.kind === "group");
}
const assistantGroups = (props: Partial<CachedChatItemsProps>) =>
  messageGroups(props).filter((group) => group.role === "assistant");
const forwarded = { provenance: { kind: "inter_session", sourceTool: "sessions_send" } };
const projected = { senderSession: { sessionKey: "agent:other:main", agentId: "other" } };
const alice = prompt("alice", 1000);
const followUp = prompt("bob", 1003);
const conversation = [
  alice,
  assistantMessage("For Alice", 1001),
  prompt("bob", 1002),
  followUp,
  assistantMessage("For Bob", 1004),
];
beforeEach(() => resetChatThreadState());
it("attributes replies to the latest grouped prompt from each sender", () => {
  const groups = messageGroups({ messages: conversation });
  const replies = groups.filter((group) => group.role === "assistant");
  expect(replies[0]).toMatchObject({
    replyToSender: { id: "alice", name: "Alice" },
    replyToMessage: { message: alice },
  });
  const bob = groups.find((group) => group.role === "user" && group.sender?.id === "bob");
  expect(bob?.messages).toHaveLength(2);
  expect(replies[1]).toMatchObject({
    replyToSender: { id: "bob", name: "Bob" },
    replyToMessage: { message: followUp, key: bob?.messages.at(-1)?.key },
  });
});
it.each([
  boundary("sender-less user", false, { role: "user" }),
  boundary("[System] Scheduled report", false, {
    role: "user",
    provenance: { kind: "internal_system", sourceTool: "cron" },
    __openclaw: { idempotencyKey: "system-run:user" },
  }),
  boundary("human prompt", true, { role: "user", __openclaw: sender("bob") }, "Bob"),
  boundary("forwarded input", true, {
    senderLabel: "Forwarded from main",
    ...forwarded,
  }),
  boundary("projected source", true, projected),
  boundary("cron delivery", true, {
    senderLabel: "Daily report",
    provenance: {
      kind: "internal_system",
      sourceTool: "cron",
      jobId: "daily",
      runId: "cron-run",
      sourceSessionKey: "agent:main:cron:daily",
    },
  }),
  boundary("projected turn", true, {
    __openclaw: { turnBoundary: true },
  }),
])("attributes $boundary prompts (search=$searchOpen)", ({ message, recipient, searchOpen }) => {
  const groups = messageGroups({
    searchOpen,
    searchQuery: "Rollout",
    replyPeople: searchOpen ? ["alice", "bob"].map((id) => profileKey(id)) : undefined,
    messages: searchOpen
      ? [
          alice,
          assistantMessage("Rollout started", 1001),
          message,
          assistantMessage("Rollout done", 1003),
        ]
      : [...conversation, message, assistantMessage("After boundary", 1007)],
  });
  if (searchOpen) {
    expect(groups.map((group) => [group.messages.length, group.replyToSender?.name])).toEqual([
      [1, "Alice"],
      [1, recipient],
    ]);
  } else {
    const last = groups.findLast((group) => group.role === "assistant");
    expect([last?.replyToSender, last?.replyToMessage]).toEqual([undefined, undefined]);
  }
});

it("keeps tool results across a hidden turn boundary", () => {
  const invocation = assistantMessage(
    [
      { type: "text", text: "Rollout started" },
      { type: "tool_call", id: "reused", name: "custom", arguments: {} },
    ],
    1000,
  );
  const separator = chatMessage("user", "New request", 1001);
  const result = toolResult("reused", "custom", "Rollout result", 1002);
  const sources = messageGroups({
    messages: [invocation, separator, result],
    searchOpen: true,
    searchQuery: "Rollout",
  }).flatMap((group) => group.messages);
  expect(sources.map((source) => source.message)).toEqual([invocation, result]);
});

it.each(["pending", "local"] as const)(
  "attributes recovered output across hidden %s prompts",
  (source) => {
    const local = source === "local";
    const recovery = prompt("bob", 1002, { id: "pending:bob" });
    const groups = messageGroups({
      searchOpen: true,
      searchQuery: "Rollout",
      replyLocalPerson: local ? localParticipantIdentityKey("viewer") : undefined,
      messages: [
        prompt(local ? "bob" : "alice", 1000, {}, "Rollout plan?"),
        assistantMessage("Rollout started", 1001),
        assistantMessage(
          "Rollout resumed",
          1003,
          local ? { __openclaw: { id: "recovered", seq: 3, runId: "local-run" } } : {},
        ),
      ],
      queue: local
        ? [
            queued("local", "Please resume", 1002, "waiting-reconnect", {
              sendRunId: "local-run",
              sendAttempts: 1,
            }),
          ]
        : [],
      pendingInputs: local
        ? undefined
        : [{ id: "bob", acceptedAt: 1002, state: "interrupted", message: recovery }],
    });
    const replies = groups.filter((group) => group.role === "assistant");
    expect(replies.map((group) => [group.messages.length, group.replyToSender?.name])).toEqual([
      [1, local ? "Bob" : "Alice"],
      [1, local ? undefined : "Bob"],
    ]);
    if (local) {
      expect(replies[1]).toMatchObject({
        replyShared: true,
        replyTurnSource: { key: "msg:send:local-run:0" },
      });
    } else {
      expect(replies[1]?.replyTurnSource?.message).toBe(recovery);
      expect(
        groups.some((group) => group.messages.some((entry) => entry.message === recovery)),
      ).toBe(false);
    }
  },
);

it.each([false, true])("attributes live output before future input (search=%s)", (searchOpen) => {
  const current = prompt("bob", 1000, { id: "pending:current" });
  const future = prompt("alice", 1001, { id: "pending:future" }, "Rollout follow-up");
  const items = buildItems({
    searchOpen,
    searchQuery: "Rollout",
    runId: "current",
    stream: "Rollout in progress",
    streamStartedAt: 1002,
    pendingInputs: [queuedPrompt("current", current, 1000), queuedPrompt("future", future, 1001)],
  });
  const streamIndex = items.findIndex((item) => item.kind === "stream");
  const futureIndex = items.findIndex(
    (item) => item.kind === "group" && item.messages.some((source) => source.message === future),
  );
  expect(streamIndex).toBeGreaterThanOrEqual(0);
  expect(streamIndex).toBeLessThan(futureIndex);
  const stream = items[streamIndex];
  expect(stream).toMatchObject({ replyToSender: { name: "Bob" } });
  expect(stream?.kind === "stream" && stream.replyToMessage?.message).toBe(current);
});

const viewer = localParticipantIdentityKey("viewer");
const identityCases: [string, Fields[], boolean?, string[]?, string?][] = [
  ["listed legacy profile", [sender()], undefined, [profileKey("alice")]],
  [
    "renamed untyped sender",
    [sender(), sender("alice", { senderName: "Renamed", senderUsername: "al" })],
  ],
  ["typed after untyped profile", [sender(), person("alice")]],
  ["two untyped senders", [sender(), sender("bob")], true, [profileKey("alice")]],
  ["observation field order", [observedSender("work"), observedSender("work", true)]],
  ["distinct accounts", [observedSender("work"), observedSender("personal")], true],
  ["local viewer beside peer", [{}, person("bob")], true, [viewer], viewer],
  ["local viewer beside self", [{}, person("viewer")], undefined, [viewer], viewer],
];
it.each(identityCases)(
  "counts people by stable identity: %s",
  (_label, senders, shared, people, localPerson) => {
    const prompts = senders.map((metadata, index) =>
      nativeMessage("user", `Ask ${index}`, index * 2, metadata),
    );
    const groups = messageGroups({
      replyPeople: people,
      replyLocalPerson: localPerson,
      messages: prompts.flatMap((entry, index) => [
        entry,
        assistantMessage(`Answer ${index}`, index * 2 + 1),
      ]),
    });
    expect(groups.map((group) => group.replyShared)).toEqual(groups.map(() => shared));
    const last = groups.at(-1);
    if (!shared) {
      expect([last?.replyToSender, last?.replyToMessage]).toEqual([undefined, undefined]);
    }
    expect(last?.replyTurnSource?.message).toMatchObject({ content: `Ask ${senders.length - 1}` });
    expect(last?.replyToMessage?.message).toBe(shared ? prompts.at(-1) : undefined);
    if (localPerson) {
      expect(groups.find((group) => group.role === "assistant")?.replyToSender).toBeUndefined();
    }
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
  expect(
    items.filter((item) => item.kind === "group").map((group) => group.messages.length),
  ).toEqual(groups === 1 ? [2] : [1, 1]);
});

it.each([
  ["sender provenance", "second", "Bobby", "/api/users/bob/avatar?v=2"],
  ["prompt content", "updated prompt", "Bob", undefined],
] as const)(
  "%s refreshes attribution on an unchanged assistant reply",
  (_changed, text, name, avatar) => {
    const first = prompt("alice", 1, person("alice", "Alice"));
    const bob = prompt("bob", 2, { id: "bob-prompt", ...person("bob", "Bob") }, "second");
    const reply = assistantMessage("answer", 3);
    const input = createProps({ messages: [first, bob, reply] });
    const original = assistantGroups(input)[0];
    const replacement = {
      ...bob,
      content: text,
      __openclaw: {
        ...bob["__openclaw"],
        senderName: name,
        ...(avatar ? { senderProfileAvatarUrl: avatar } : {}),
      },
    };
    const updated = assistantGroups({ ...input, messages: [first, replacement, reply] })[0];
    expect(updated).toMatchObject({
      replyToSender: { name, ...(avatar ? { profileAvatarUrl: avatar } : {}) },
    });
    expect(updated?.replyToMessage?.message).toBe(replacement);
    expect(updated?.replyToMessage?.key).toBe(original?.replyToMessage?.key);
  },
);
