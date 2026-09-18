// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
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
    resetChatThreadState();
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
      replyToMessage: { message: replacement },
    });
    expect(updated?.kind === "group" && updated.replyToMessage?.message).toBe(replacement);
    expect(updated?.kind === "group" && updated.replyToMessage?.key).toBe(
      original?.kind === "group" ? original.replyToMessage?.key : undefined,
    );
  });
});
