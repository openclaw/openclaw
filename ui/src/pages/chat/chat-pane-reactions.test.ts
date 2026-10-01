/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-reactions.test/"} */
import { describe, expect, it } from "vitest";
import type {
  MessageReactionSummary,
  SessionReactionEvent,
  SessionReactionsListResult,
  SessionReactionsSetResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

const peerReaction: MessageReactionSummary[] = [
  { emoji: "👍", count: 1, identities: [{ id: "riley", label: "Riley" }] },
];
type ReactionsPane = {
  syncSessionReactions(): void;
  handleSessionReactionEvent(event: SessionReactionEvent): void;
  setMessageReaction(messageId: string, emoji: string, remove: boolean): Promise<void>;
  messageReactions: Map<string, MessageReactionSummary[]>;
  pendingReactionMessageIds: ReadonlyMap<string, unknown>;
};

function fixture(
  list: Promise<SessionReactionsListResult>,
  set?: Promise<SessionReactionsSetResult>,
) {
  const requests: string[] = [];
  const client = createTestGatewayClient((method) => {
    requests.push(method);
    return method === "session.reactions.set" ? set : list;
  });
  const created = createTestChatPane({ client });
  created.pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
    ["session.reactions.list", "session.reactions.set"],
    ["operator.write"],
  );
  const pane = created.pane as typeof created.pane & ReactionsPane;
  const session = (sessionId: string) => {
    created.state.currentSessionId = sessionId;
    created.state.sessionsResult = sessionsResult(
      [
        {
          key: created.state.sessionKey,
          sessionId,
          kind: "direct",
          updatedAt: 1,
          sharingRole: "owner",
          visibility: "shared",
        },
      ],
      1,
    );
  };
  session("session-1");
  const event = (reactions = peerReaction): SessionReactionEvent => ({
    sessionKey: created.state.sessionKey,
    sessionId: "session-1",
    agentId: "main",
    messageId: "message-1",
    emoji: "👍",
    action: "added",
    actor: { type: "human", id: "riley", label: "Riley" },
    reactions,
  });
  return { ...created, pane, session, event, requests };
}

describe("pane reaction ownership", () => {
  it("projects pending writes without optimistic success and keeps existing UI errors", async () => {
    const set = createDeferred<SessionReactionsSetResult>();
    const { pane, state, requests, event } = fixture(
      Promise.resolve({ sessionId: "session-1", reactions: {} }),
      set.promise,
    );
    pane.syncSessionReactions();
    await Promise.resolve();
    await Promise.resolve();
    pane.handleSessionReactionEvent(event());
    const write = pane.setMessageReaction("message-1", "👍", true);
    expect(pane.pendingReactionMessageIds.has("message-1")).toBe(true);
    expect(pane.messageReactions.get("message-1")).toEqual(peerReaction);
    set.reject(new Error("offline"));
    await write;
    expect(pane.pendingReactionMessageIds.has("message-1")).toBe(false);
    expect(pane.messageReactions.get("message-1")).toEqual(peerReaction);
    expect(state.chatError).toContain("offline");
    expect(state.lastError).toBe(state.chatError);
    expect(requests).toEqual(["session.reactions.list", "session.reactions.set"]);
  });
  it("loads once per session and retains live events over an older list response", async () => {
    const list = createDeferred<SessionReactionsListResult>();
    const { pane, event, requests } = fixture(list.promise);
    pane.syncSessionReactions();
    pane.syncSessionReactions();
    pane.handleSessionReactionEvent(event());
    list.resolve({ sessionId: "session-1", reactions: {} });
    await list.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual(["session.reactions.list"]);
    expect(pane.messageReactions.get("message-1")).toEqual(peerReaction);
  });

  it("clears reset sessions and rejects their delayed reads, writes, and events", async () => {
    const list = createDeferred<SessionReactionsListResult>();
    const set = createDeferred<SessionReactionsSetResult>();
    const { pane, session, event } = fixture(list.promise, set.promise);
    pane.syncSessionReactions();
    pane.handleSessionReactionEvent(event());
    const write = pane.setMessageReaction("message-1", "🎉", false);
    session("session-2");
    pane.syncSessionReactions();
    pane.handleSessionReactionEvent(event());
    list.resolve({ sessionId: "session-1", reactions: { "message-1": peerReaction } });
    set.resolve({ messageId: "message-1", reactions: peerReaction });
    await write;
    expect(pane.messageReactions.size).toBe(0);
  });

  it("does not replace a newer peer event with a delayed set response", async () => {
    const list = createDeferred<SessionReactionsListResult>();
    const set = createDeferred<SessionReactionsSetResult>();
    const { pane, event } = fixture(list.promise, set.promise);
    pane.syncSessionReactions();
    list.resolve({ sessionId: "session-1", reactions: {} });
    await list.promise;
    await Promise.resolve();
    await Promise.resolve();
    const write = pane.setMessageReaction("message-1", "🎉", false);
    pane.handleSessionReactionEvent(event());
    set.resolve({ messageId: "message-1", reactions: [] });
    await write;
    expect(pane.messageReactions.get("message-1")).toEqual(peerReaction);
  });
});
