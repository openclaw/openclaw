import { afterEach, describe, expect, it } from "vitest";
import type { BuildChatItemsProps } from "./chat-thread-build.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

const message = (role: string, text: string, seq: number, runId = text) => ({
  role,
  content: text,
  timestamp: seq * 10,
  __openclaw: {
    id: text,
    seq,
    runId,
    idempotencyKey: role === "user" ? `${runId}:user` : undefined,
  },
});
const history = [message("user", "Earlier request", 1), message("assistant", "Earlier reply", 2)];
const handoff = {
  id: "handoff",
  runId: "handoff-run",
  acceptedAt: 5,
  state: "cancelled" as const,
  message: {
    role: "assistant",
    content: "The handoff is ready.",
    timestamp: 5,
    provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    senderSession: { sessionKey: "agent:helper:main", agentId: "helper" },
    __openclaw: { id: "pending:handoff" },
  },
};
const nextUser = message("user", "Continue from the handoff.", 3, "next-run");
const preview = {
  role: "toolResult",
  toolCallId: "app-call",
  toolName: "demo__show",
  content: [{ type: "text", text: "ok" }],
  timestamp: 25,
  details: {
    mcpAppPreview: {
      kind: "canvas",
      view: { id: "app-view", title: "Demo App" },
      presentation: { target: "assistant_message", sandbox: "scripts" },
      mcpApp: {
        viewId: "app-view",
        serverName: "demo",
        toolName: "show",
        uiResourceUri: "ui://demo/app.html",
        toolCallId: "app-call",
      },
    },
  },
};
function props(overrides: Partial<BuildChatItemsProps> = {}): BuildChatItemsProps {
  return {
    paneId: "pending-order",
    sessionKey: "agent:main:pending-order",
    messages: history,
    pendingInputs: [handoff],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}
function visible(input: BuildChatItemsProps) {
  return buildCachedChatItems(input).flatMap((item) =>
    item.kind === "group" ? item.messages.map((source) => source.message) : [],
  );
}

afterEach(() => resetChatThreadState());

describe("observed pending-input order", () => {
  it.each(["queued", "cancelled", "interrupted"] as const)(
    "keeps an already displayed %s handoff before a later persisted user turn",
    (state) => {
      const pendingInputs = [{ ...handoff, state }];
      expect(visible(props({ pendingInputs }))).toEqual([...history, handoff.message]);
      const messages = [...history, nextUser];
      expect(visible(props({ messages, pendingInputs }))).toEqual([
        ...history,
        handoff.message,
        nextUser,
      ]);
      const nextReply = message("assistant", "Follow-up complete.", 4, "next-run");
      expect(visible(props({ messages: [...messages, nextReply], pendingInputs }))).toEqual([
        ...history,
        handoff.message,
        nextUser,
        nextReply,
      ]);
      if (state !== "queued") {
        const items = buildCachedChatItems(props({ messages, pendingInputs }));
        const noticeIndex = items.findIndex((item) => item.kind === "notice");
        const userIndex = items.findIndex(
          (item) =>
            item.kind === "group" && item.messages.some((entry) => entry.message === nextUser),
        );
        expect(noticeIndex).toBeGreaterThan(-1);
        expect(noticeIndex).toBeLessThan(userIndex);
      }
    },
  );

  it.each(["submitting", "sending", "waiting-model", "waiting-reconnect"] as const)(
    "keeps the handoff before a later %s send across custody and persistence",
    (sendState) => {
      visible(props());
      const queue = [
        {
          id: "new-send",
          text: nextUser.content,
          createdAt: 1,
          sendRunId: "next-run",
          sendSubmittedAtMs: 1,
          sendAttempts: sendState === "sending" || sendState === "waiting-reconnect" ? 1 : 0,
          sendState,
        },
      ];
      expect(visible(props({ queue, runId: "next-run" }))).toEqual([
        ...history,
        handoff.message,
        expect.objectContaining({ content: [{ type: "text", text: nextUser.content }] }),
      ]);
      const accepted = {
        id: "new-send",
        runId: "next-run",
        acceptedAt: 30,
        state: "queued" as const,
        message: { ...nextUser, __openclaw: { id: "pending:new-send" } },
      };
      expect(visible(props({ pendingInputs: [handoff, accepted], queue }))).toEqual([
        ...history,
        handoff.message,
        accepted.message,
      ]);
      expect(visible(props({ messages: [...history, nextUser] }))).toEqual([
        ...history,
        handoff.message,
        nextUser,
      ]);
    },
  );

  it("keeps the current assistant reply before custody without moving custody past the next turn", () => {
    visible(props());
    const completion = message("assistant", "Current work complete.", 3);
    const messages = [...history, completion];
    const followingUser = message("user", "Continue from the handoff.", 4, "next-run");
    expect(visible(props({ messages }))).toEqual([...messages, handoff.message]);
    expect(visible(props({ messages: [...messages, followingUser] }))).toEqual([
      ...messages,
      handoff.message,
      followingUser,
    ]);
  });

  it("does not lose the observed position while search hides its anchor", () => {
    visible(props());
    const messages = [...history, nextUser];
    expect(visible(props({ messages, searchOpen: true, searchQuery: "handoff" }))).toEqual([
      handoff.message,
      nextUser,
    ]);
    expect(visible(props({ messages }))).toEqual([...history, handoff.message, nextUser]);
  });

  it.each([
    { kind: "inter_session", sourceTool: "sessions_send" },
    {
      kind: "internal_system",
      sourceTool: "cron",
      jobId: "scheduled-job",
      runId: "scheduled-run",
      sourceSessionKey: "agent:helper:main",
    },
  ])("keeps a handoff before a later forwarded $sourceTool turn", (provenance) => {
    visible(props());
    const forwarded = {
      ...message("assistant", "A new forwarded request.", 3),
      provenance,
      senderSession: { sessionKey: "agent:helper:main", agentId: "helper" },
    };
    const reply = message("assistant", "The forwarded task is done.", 4);
    expect(visible(props({ messages: [...history, forwarded, reply] }))).toEqual([
      ...history,
      handoff.message,
      forwarded,
      reply,
    ]);
  });

  it.each([false, true])(
    "keeps the true turn ceiling when search hides it (ceiling observed: %s)",
    (observeCeiling) => {
      const matchingHistory = [history[0]!, message("assistant", "Earlier handoff reply", 2)];
      visible(props({ messages: matchingHistory }));
      const hiddenUser = message("user", "Continue the task.", 3);
      if (observeCeiling) {
        visible(props({ messages: [...matchingHistory, hiddenUser] }));
      }
      const reply = message("assistant", "The handoff was processed.", 4);
      const laterUser = message("user", "Another handoff request.", 5);
      const messages = [...matchingHistory, hiddenUser, reply, laterUser];
      expect(visible(props({ messages, searchOpen: true, searchQuery: "handoff" }))).toEqual([
        matchingHistory[1],
        handoff.message,
        reply,
        laterUser,
      ]);
    },
  );

  it("keeps observed placement when browsing away from and back to a custody page", () => {
    visible(props());
    const messages = [...history, nextUser];
    visible(props({ messages }));
    visible(
      props({
        messages,
        pendingInputs: [{ ...handoff, id: "older-handoff", runId: "older-handoff-run" }],
      }),
    );
    expect(visible(props({ messages }))).toEqual([...history, handoff.message, nextUser]);
  });

  it.each([false, true])(
    "keeps the true turn ceiling ahead of a local send when search hides history (later canonical turn: %s)",
    (hasLaterCanonicalTurn) => {
      visible(props());
      const hiddenUser = message("user", "Continue the task.", 3);
      const queue = [
        {
          id: "new-send",
          text: "Another handoff request.",
          createdAt: 40,
          sendRunId: "new-run",
          sendSubmittedAtMs: 40,
          sendState: "submitting" as const,
        },
      ];
      expect(
        visible(
          props({
            messages: hasLaterCanonicalTurn ? [...history, hiddenUser] : history,
            queue,
            searchOpen: true,
            searchQuery: "handoff",
          }),
        ),
      ).toEqual([
        handoff.message,
        expect.objectContaining({ content: [{ type: "text", text: queue[0]!.text }] }),
      ]);
    },
  );

  it.each(["queued", "cancelled", "interrupted"] as const)(
    "keeps a handoff before %s custody with an earlier timestamp",
    (state) => {
      visible(props());
      const queue = [
        {
          id: "new-send",
          text: nextUser.content,
          createdAt: 1,
          sendRunId: "next-run",
          sendSubmittedAtMs: 1,
          sendState: "submitting" as const,
        },
      ];
      expect(visible(props({ queue }))).toEqual([
        ...history,
        handoff.message,
        expect.objectContaining({ content: [{ type: "text", text: nextUser.content }] }),
      ]);
      const accepted = {
        id: "new-send",
        runId: "next-run",
        acceptedAt: 1,
        state,
        message: { ...nextUser, timestamp: 1, __openclaw: { id: "pending:new-send" } },
      };
      expect(visible(props({ pendingInputs: [accepted, handoff] }))).toEqual([
        ...history,
        handoff.message,
        accepted.message,
      ]);
      const items = buildCachedChatItems(props({ pendingInputs: [accepted, handoff] }));
      const handoffIndex = items.findIndex(
        (item) =>
          item.kind === "group" && item.messages.some((entry) => entry.message === handoff.message),
      );
      const acceptedIndex = items.findIndex(
        (item) =>
          item.kind === "group" &&
          item.messages.some((entry) => entry.message === accepted.message),
      );
      expect(handoffIndex).toBeGreaterThanOrEqual(0);
      expect(items[handoffIndex + 1]?.key).toBe("pending-input:handoff:state");
      expect(acceptedIndex).toBeGreaterThan(handoffIndex + 1);
      if (state !== "queued") {
        expect(items[acceptedIndex + 1]?.key).toBe("pending-input:new-send:state");
      } else {
        expect(visible(props({ messages: [...history, nextUser] }))).toEqual([
          ...history,
          handoff.message,
          nextUser,
        ]);
      }
    },
  );

  function observeFollowups() {
    visible(props());
    const firstQueue = {
      id: "first",
      text: "First follow-up.",
      createdAt: 1,
      sendRunId: "first-run",
      sendSubmittedAtMs: 1,
      sendState: "submitting" as const,
    };
    visible(props({ queue: [firstQueue] }));
    const first = {
      id: "first",
      runId: "first-run",
      acceptedAt: 1,
      state: "queued" as const,
      message: { role: "user", content: firstQueue.text, timestamp: 1 },
    };
    visible(props({ pendingInputs: [first, handoff] }));
    const secondQueue = {
      id: "second",
      text: "Second handoff follow-up.",
      createdAt: 0,
      sendRunId: "second-run",
      sendSubmittedAtMs: 0,
      sendState: "submitting" as const,
    };
    visible(props({ pendingInputs: [first, handoff], queue: [secondQueue] }));
    const second = {
      id: "second",
      runId: "second-run",
      acceptedAt: 0,
      state: "queued" as const,
      message: { role: "user", content: secondQueue.text, timestamp: 0 },
    };
    visible(props({ pendingInputs: [second, first, handoff] }));
    return { first, second };
  }

  it.each(["neither", "first", "second", "both"] as const)(
    "keeps the observed input sequence when %s follow-ups become canonical",
    (promoted) => {
      const { first, second } = observeFollowups();
      const firstSaved = message("user", first.message.content, 3, first.runId);
      const secondSaved = message("user", second.message.content, 4, second.runId);
      const saveFirst = promoted === "first" || promoted === "both";
      const saveSecond = promoted === "second" || promoted === "both";
      const messages = [
        ...history,
        ...(saveFirst ? [firstSaved] : []),
        ...(saveSecond ? [secondSaved] : []),
      ];
      const pendingInputs = [
        ...(saveSecond ? [] : [second]),
        ...(saveFirst ? [] : [first]),
        handoff,
      ];
      expect(visible(props({ messages, pendingInputs }))).toEqual([
        ...history,
        handoff.message,
        saveFirst ? firstSaved : first.message,
        saveSecond ? secondSaved : second.message,
      ]);
    },
  );

  it("projects the observed input sequence through search-hidden middle custody", () => {
    const { first, second } = observeFollowups();
    expect(
      visible(
        props({
          pendingInputs: [second, first, handoff],
          searchOpen: true,
          searchQuery: "handoff",
        }),
      ),
    ).toEqual([handoff.message, second.message]);
    expect(visible(props({ pendingInputs: [second, first, handoff] }))).toEqual([
      ...history,
      handoff.message,
      first.message,
      second.message,
    ]);
  });

  it.each(["submitting", "waiting-reconnect"] as const)(
    "observes a new %s send during search before custody acceptance",
    (sendState) => {
      visible(props());
      const search = { searchOpen: true, searchQuery: "handoff" };
      visible(props(search));
      const queue = [
        {
          id: "new-send",
          text: nextUser.content,
          createdAt: 1,
          sendRunId: "next-run",
          sendSubmittedAtMs: 1,
          sendAttempts: 1,
          sendState,
        },
      ];
      expect(visible(props({ ...search, queue }))).toEqual([
        handoff.message,
        expect.objectContaining({ content: [{ type: "text", text: nextUser.content }] }),
      ]);
      const accepted = {
        id: "new-send",
        runId: "next-run",
        acceptedAt: 1,
        state: "queued" as const,
        message: { ...nextUser, timestamp: 1, __openclaw: { id: "pending:new-send" } },
      };
      expect(visible(props({ ...search, pendingInputs: [accepted, handoff] }))).toEqual([
        handoff.message,
        accepted.message,
      ]);
      expect(visible(props({ pendingInputs: [accepted, handoff] }))).toEqual([
        ...history,
        handoff.message,
        accepted.message,
      ]);
    },
  );

  it("preserves a local predecessor when a handoff first appears after it", () => {
    const queue = [
      {
        id: "new-send",
        text: nextUser.content,
        createdAt: 1,
        sendRunId: "next-run",
        sendSubmittedAtMs: 1,
        sendState: "submitting" as const,
      },
    ];
    visible(props({ queue, pendingInputs: [] }));
    const observed = visible(props({ queue }));
    expect(observed.at(-1)).toBe(handoff.message);
    const accepted = {
      id: "new-send",
      runId: "next-run",
      acceptedAt: 50,
      state: "queued" as const,
      message: { ...nextUser, timestamp: 50, __openclaw: { id: "pending:new-send" } },
    };
    expect(visible(props({ pendingInputs: [handoff, accepted] }))).toEqual([
      ...history,
      accepted.message,
      handoff.message,
    ]);
  });

  it("keeps a forwarded custody promotion before its observed successor", () => {
    const forwarded = { ...handoff, state: "queued" as const };
    visible(props({ pendingInputs: [forwarded] }));
    const queue = [
      {
        id: "new-send",
        text: nextUser.content,
        createdAt: 1,
        sendRunId: "next-run",
        sendSubmittedAtMs: 1,
        sendState: "submitting" as const,
      },
    ];
    visible(props({ pendingInputs: [forwarded], queue }));
    const accepted = {
      id: "new-send",
      runId: "next-run",
      acceptedAt: 1,
      state: "queued" as const,
      message: { ...nextUser, timestamp: 1, __openclaw: { id: "pending:new-send" } },
    };
    visible(props({ pendingInputs: [accepted, forwarded], queue }));
    const promoted = {
      ...forwarded.message,
      __openclaw: {
        id: forwarded.id,
        seq: 3,
        idempotencyKey: "handoff-run:user",
        runId: "handoff-run",
      },
    };
    expect(visible(props({ messages: [...history, promoted], pendingInputs: [accepted] }))).toEqual(
      [...history, promoted, accepted.message],
    );
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "keeps observed custody before its recovered reply (reply before acceptance: %s, search-hidden: %s)",
    (replyBeforeAcceptance, searchHidden) => {
      visible(props());
      const search = searchHidden ? { searchOpen: true, searchQuery: "handoff" } : {};
      const queue = [
        {
          id: "new-send",
          text: nextUser.content,
          createdAt: 1,
          sendRunId: "next-run",
          sendSubmittedAtMs: 1,
          sendState: "submitting" as const,
        },
      ];
      visible(props({ ...search, queue }));
      const reply = message("assistant", "The follow-up is complete.", 4, "next-run");
      const messages = [...history, reply];
      if (replyBeforeAcceptance) {
        visible(props({ ...search, messages, queue }));
      }
      const accepted = {
        id: "new-send",
        runId: "next-run",
        acceptedAt: 1,
        state: "queued" as const,
        message: { ...nextUser, timestamp: 1, __openclaw: { id: "pending:new-send" } },
      };
      const pendingInputs = [accepted, handoff];
      visible(
        props({
          ...search,
          messages: replyBeforeAcceptance ? messages : history,
          pendingInputs,
          queue,
        }),
      );
      expect(visible(props({ messages, pendingInputs, queue }))).toEqual([
        ...history,
        handoff.message,
        accepted.message,
        reply,
      ]);
    },
  );

  it("keeps a handoff that first appears during search after all earlier history", () => {
    const matchingReply = message("assistant", "Earlier handoff reply", 2);
    const earlierHistory = [
      history[0]!,
      matchingReply,
      message("user", "Hidden older request", 3),
      message("assistant", "Hidden older reply", 4),
    ];
    const search = { searchOpen: true, searchQuery: "handoff" };
    visible(props({ messages: earlierHistory, pendingInputs: [], ...search }));
    expect(visible(props({ messages: earlierHistory, ...search }))).toEqual([
      matchingReply,
      handoff.message,
    ]);
    const laterUser = message("user", "Continue from the handoff.", 5, "next-run");
    const messages = [...earlierHistory, laterUser];
    expect(visible(props({ messages, ...search }))).toEqual([
      matchingReply,
      handoff.message,
      laterUser,
    ]);
    expect(visible(props({ messages }))).toEqual([...earlierHistory, handoff.message, laterUser]);
  });

  it("does not retain placement for custody never displayed by search", () => {
    visible(props({ searchOpen: true, searchQuery: "Earlier" }));
    const messages = [...history, nextUser];
    expect(visible(props({ messages, searchOpen: true, searchQuery: "handoff" }))).toEqual([
      nextUser,
      handoff.message,
    ]);
  });

  it("scopes observed placement to the pane and session and retires it on reset", () => {
    visible(props());
    const messages = [...history, nextUser];
    for (const scope of [{ paneId: "other" }, { sessionKey: "agent:main:other" }]) {
      expect(visible(props({ ...scope, messages }))).toEqual([...messages, handoff.message]);
    }
    resetChatThreadState("pending-order");
    expect(visible(props({ messages }))).toEqual([...messages, handoff.message]);
  });

  it("keeps the true turn ceiling when search hides a lifted preview floor", () => {
    const messages = [...history, preview];
    const initial = visible(props({ messages, showToolCalls: false }));
    expect(initial).toHaveLength(4);
    expect(initial.at(-1)).toBe(handoff.message);
    expect(initial[2]).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ type: "canvas" })],
    });
    const queue = [
      {
        id: "new-send",
        text: "Another handoff request.",
        createdAt: 40,
        sendRunId: "new-run",
        sendSubmittedAtMs: 40,
        sendState: "submitting" as const,
      },
    ];
    expect(
      visible(
        props({ messages, queue, showToolCalls: false, searchOpen: true, searchQuery: "handoff" }),
      ),
    ).toEqual([
      handoff.message,
      expect.objectContaining({ content: [{ type: "text", text: queue[0]!.text }] }),
    ]);
  });

  it("keeps the true turn ceiling before a later turn's lifted preview in search", () => {
    visible(props());
    const hiddenUser = message("user", "Continue the task.", 3);
    const reply = message("assistant", "The handoff result is ready.", 5);
    const messages = [...history, hiddenUser, preview, reply];
    expect(
      visible(props({ messages, showToolCalls: false, searchOpen: true, searchQuery: "handoff" })),
    ).toEqual([
      handoff.message,
      expect.objectContaining({
        role: "assistant",
        content: [expect.objectContaining({ type: "canvas" })],
      }),
      reply,
    ]);
  });

  it.each(["reset", "compaction", "live-compaction"])(
    "keeps the true turn ceiling before a later %s divider in search",
    (kind) => {
      visible(props());
      const hiddenUser = message("user", "Continue the task.", 3);
      const divider = {
        ...message("system", "Context boundary", 4),
        __openclaw: {
          id: "context-boundary",
          seq: 4,
          kind: kind === "reset" ? "reset" : "compaction",
          runId: "compaction-run",
        },
      };
      const reply = message("assistant", "The handoff result is ready.", 5);
      const compactionStatus =
        kind === "live-compaction"
          ? { phase: "complete" as const, runId: "compaction-run", startedAt: 39, completedAt: 40 }
          : undefined;
      const items = buildCachedChatItems(
        props({
          messages: [...history, hiddenUser, divider, reply],
          compactionStatus,
          searchOpen: true,
          searchQuery: "handoff",
        }),
      );
      const handoffIndex = items.findIndex(
        (item) =>
          item.kind === "group" && item.messages.some((entry) => entry.message === handoff.message),
      );
      const dividerIndex = items.findIndex((item) => item.kind === "divider");
      const replyIndex = items.findIndex(
        (item) => item.kind === "group" && item.messages.some((entry) => entry.message === reply),
      );
      expect(handoffIndex).toBeGreaterThanOrEqual(0);
      expect(dividerIndex).toBeGreaterThan(handoffIndex);
      expect(replyIndex).toBeGreaterThan(dividerIndex);
    },
  );
});
