/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createNativeShowEarlierPane } from "./chat-pane-history.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";
import { readChatSessionSnapshot } from "./session-message-cache.ts";

describe("chat pane history submission reconciliation", () => {
  it("replaces a retained follow-up when its canonical user arrives in older history", async () => {
    const canonical = {
      role: "user",
      content: "land PR",
      __openclaw: {
        id: "land-input",
        seq: 1,
        idempotencyKey: "land-submission:user",
        runId: "land-execution",
        senderName: "Author",
      },
    };
    const peer = {
      ...canonical,
      __openclaw: {
        ...canonical["__openclaw"],
        id: "peer-input",
        seq: 2,
        idempotencyKey: "peer-submission:user",
      },
    };
    const { pane, state } = createNativeShowEarlierPane(
      vi.fn(async () => ({
        messages: [canonical, peer],
        hasMore: false,
        sessionId: "session-id",
        totalMessages: 4,
      })),
    );
    state.currentSessionId = "session-id";
    state.chatMessagesBySession = new Map();
    const tail = [...state.chatMessages];
    for (const runId of ["land-submission", "unrelated-submission"]) {
      reduceChatSessionProjection(state, {
        type: "sendPending",
        runId,
        message: {
          role: "user",
          content: "land PR",
          __openclaw: { idempotencyKey: `${runId}:user`, senderName: "Author" },
        },
      });
    }
    const unrelated = state.chatMessages.at(-1);
    const live = { role: "assistant", content: "Still working", __openclaw: { runId: "live-run" } };
    reduceChatSessionProjection(state, { type: "messagePersisted", message: live });

    await pane.loadOlderMessages();

    expect(state.chatMessages).toEqual([canonical, peer, ...tail, unrelated, live]);
    expect(
      readChatSessionSnapshot(state.chatMessagesBySession, state, { sessionKey: state.sessionKey })
        ?.messages,
    ).toEqual(state.chatMessages);
    reduceChatSessionProjection(state, { type: "sendFailed", runId: "unrelated-submission" });
    expect(state.chatMessages).toEqual([canonical, peer, ...tail, live]);
  });
});
