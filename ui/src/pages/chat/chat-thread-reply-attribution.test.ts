// @vitest-environment node
import { beforeEach, expect, it } from "vitest";
import {
  localParticipantIdentityKey,
  sessionParticipantIdentityKey,
} from "../../lib/chat/sender-label.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import { buildItems, createProps, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import { resetChatThreadState } from "./chat-thread.ts";

type Fields = Record<string, unknown>;
function makeMessage(role: string, content: unknown, timestamp: number, fields: Fields = {}) {
  return { role, content, timestamp, ...fields };
}
const userMessage = (content: string, timestamp: number, fields: Fields = {}) =>
  makeMessage("user", content, timestamp, fields);
const assistantMessage = (content: unknown, timestamp: number, fields: Fields = {}) =>
  makeMessage("assistant", content, timestamp, fields);
function namedPrompt(
  content: string,
  timestamp: number,
  id: string,
  name = id,
  metadata: Fields = {},
) {
  return userMessage(content, timestamp, {
    __openclaw: { senderId: id, senderName: name, ...metadata },
  });
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
function profilePrompt(
  content: string,
  timestamp: number,
  id: string,
  name = id,
  metadata: Fields = {},
) {
  return namedPrompt(content, timestamp, id, name, {
    senderIdentity: { type: "profile", id },
    ...metadata,
  });
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
function senderCase(label: string, senders: Fields[], shared?: boolean, people: string[] = []) {
  return { case: label, senders, shared, people };
}
function messageGroups(props: Partial<CachedChatItemsProps>) {
  return buildItems(props).filter((item) => item.kind === "group");
}
const assistantGroups = (props: Partial<CachedChatItemsProps>) =>
  messageGroups(props).filter((group) => group.role === "assistant");
const forwarded = { provenance: { kind: "inter_session", sourceTool: "sessions_send" } };
const projected = { senderSession: { sessionKey: "agent:other:main", agentId: "other" } };
const alice = namedPrompt("Alice asks", 1000, "alice", "Alice");
const followUp = namedPrompt("Bob follows up", 1003, "bob", "Bob");
const conversation = [
  alice,
  assistantMessage("For Alice", 1001),
  namedPrompt("Bob asks", 1002, "bob", "Bob"),
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
  boundary("forwarded input", false, {
    senderSession: { sessionKey: "agent:other:main" },
    ...forwarded,
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

it.each(["human", "forwarded", "projected source"] as const)(
  "keeps tool results across a hidden %s boundary",
  (kind) => {
    const invocation = assistantMessage(
      [
        { type: "text", text: "Rollout started" },
        { type: "tool_call", id: "reused", name: "custom", arguments: {} },
      ],
      1000,
    );
    const separator =
      kind === "human"
        ? userMessage("New request", 1001)
        : assistantMessage("Forwarded request", 1001, kind === "forwarded" ? forwarded : projected);
    const result = makeMessage("toolResult", "Rollout result", 1002, {
      toolCallId: "reused",
      toolName: "custom",
    });
    const sources = messageGroups({
      messages: [invocation, separator, result],
      searchOpen: true,
      searchQuery: "Rollout",
    }).flatMap((group) => group.messages);
    expect(sources.map((source) => source.message)).toEqual([invocation, result]);
  },
);

it.each(["pending", "local"] as const)(
  "attributes recovered output across hidden %s prompts",
  (source) => {
    const local = source === "local";
    const prompt = namedPrompt("Please resume", 1002, "bob", "Bob", { id: "pending:bob" });
    const groups = messageGroups({
      searchOpen: true,
      searchQuery: "Rollout",
      replyLocalPerson: local ? localParticipantIdentityKey("viewer") : undefined,
      messages: [
        namedPrompt("Rollout plan?", 1000, local ? "bob" : "alice", local ? "Bob" : "Alice"),
        assistantMessage("Rollout started", 1001),
        assistantMessage(
          "Rollout resumed",
          1003,
          local ? { __openclaw: { id: "recovered", seq: 3, runId: "local-run" } } : {},
        ),
      ],
      queue: local
        ? [
            {
              id: "local",
              text: "Please resume",
              createdAt: 1002,
              sendRunId: "local-run",
              sendState: "waiting-reconnect",
              sendAttempts: 1,
            },
          ]
        : [],
      pendingInputs: local
        ? undefined
        : [{ id: "bob", acceptedAt: 1002, state: "interrupted", message: prompt }],
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
      expect(replies[1]?.replyTurnSource?.message).toBe(prompt);
      expect(groups.some((group) => group.messages.some((entry) => entry.message === prompt))).toBe(
        false,
      );
    }
  },
);

it.each([false, true])("attributes live output before future input (search=%s)", (searchOpen) => {
  const current = namedPrompt("Current prompt", 1000, "bob", "Bob", { id: "pending:current" });
  const future = namedPrompt("Rollout follow-up", 1001, "alice", "Alice", {
    id: "pending:future",
  });
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

it.each([
  senderCase("listed legacy profile", [sender()], undefined, [profileKey("alice")]),
  senderCase("renamed untyped sender", [
    sender(),
    sender("alice", { senderName: "Alice Liddell", senderUsername: "al" }),
  ]),
  senderCase("typed after untyped profile", [
    sender(),
    { senderId: "alice", senderIdentity: { type: "profile", id: "alice" } },
  ]),
  senderCase("two untyped senders", [sender(), sender("bob")], true, [profileKey("alice")]),
  senderCase("observation field order", [observedSender("work"), observedSender("work", true)]),
  senderCase("distinct accounts", [observedSender("work"), observedSender("personal")], true),
])("counts people by stable sender id: $case", ({ people, senders, shared }) => {
  const groups = messageGroups({
    replyPeople: people,
    messages: senders.flatMap((metadata, index) => [
      userMessage(`Ask ${index}`, index * 2, { __openclaw: metadata }),
      assistantMessage(`Answer ${index}`, index * 2 + 1),
    ]),
  });
  expect(groups.map((group) => group.replyShared)).toEqual(groups.map(() => shared));
  const last = groups.at(-1);
  if (!shared) {
    expect([last?.replyToSender, last?.replyToMessage]).toEqual([undefined, undefined]);
  }
  expect(last?.replyTurnSource?.message).toMatchObject({ content: `Ask ${senders.length - 1}` });
});

it.each([
  { peer: "bob", shared: true },
  { peer: "viewer", shared: undefined },
])("counts the local viewer beside $peer", ({ peer, shared }) => {
  const viewer = localParticipantIdentityKey("viewer");
  const attributed = profilePrompt("Status?", 1002, peer, peer);
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
  expect(first?.replyToSender).toBeUndefined();
});

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
    const first = profilePrompt("first", 1, "alice", "Alice");
    const bob = profilePrompt("second", 2, "bob", "Bob", { id: "bob-prompt" });
    const reply = assistantMessage("answer", 3);
    const input = createProps({ messages: [first, bob, reply] });
    const original = assistantGroups(input)[0];
    const replacement = profilePrompt(text, 2, "bob", name, {
      id: "bob-prompt",
      ...(avatar ? { senderProfileAvatarUrl: avatar } : {}),
    });
    const updated = assistantGroups({ ...input, messages: [first, replacement, reply] })[0];
    expect(updated).toMatchObject({
      replyToSender: { name, ...(avatar ? { profileAvatarUrl: avatar } : {}) },
    });
    expect(updated?.replyToMessage?.message).toBe(replacement);
    expect(updated?.replyToMessage?.key).toBe(original?.replyToMessage?.key);
  },
);
