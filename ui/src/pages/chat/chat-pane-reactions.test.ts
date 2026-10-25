/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-reactions.test/"} */
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  MessageReactionSummary,
  SessionReactionEvent,
  SessionReactionsListResult,
  SessionReactionsSetResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import * as toast from "../../lib/toast.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

const peerReaction: MessageReactionSummary[] = [
  { emoji: "👍", count: 1, identities: [{ id: "riley", label: "Riley" }] },
];
const selfReaction: MessageReactionSummary[] = [
  { emoji: "🎉", count: 1, identities: [{ id: "alex", label: "Alex" }] },
];
type ReactionsPane = {
  syncSessionReactions(): void;
  handleSessionReactionEvent(event: SessionReactionEvent): void;
  setMessageReaction(messageId: string, emoji: string, remove: boolean): Promise<void>;
};

function fixture(
  list: Promise<SessionReactionsListResult>,
  set?: Promise<SessionReactionsSetResult>,
) {
  const requests: string[] = [];
  const writes: unknown[] = [];
  const client = createTestGatewayClient((method, params) => {
    requests.push(method);
    if (method === "session.reactions.set") {
      writes.push(params);
    }
    return method === "session.reactions.set" ? set : list;
  });
  const created = createTestChatPane({ client });
  created.pane.context.gateway.snapshot.hello = gatewayHelloForMethods(
    ["session.reactions.list", "session.reactions.set"],
    ["operator.write"],
  );
  const pane = created.pane as typeof created.pane & ReactionsPane;
  const gateway = pane.context.gateway;
  gateway.snapshot.selfUser = {
    id: "alex",
    name: "Alex",
    identity: { type: "profile", id: "alex" },
  };
  gatewayPresentationScope(gateway);
  const deferred = new Map<string, Parameters<ApplicationGateway["defer"]>[0]>();
  const coalescedReactions: (MessageReactionSummary[] | undefined)[] = [];
  gateway.defer = (intent) => {
    if (
      gateway.snapshot.phase === "connected" &&
      deferred.size === 0 &&
      !gateway.snapshot.deferredIntentDraining
    ) {
      return false;
    }
    const superseded = deferred.get(intent.key);
    if (superseded) {
      deferred.delete(intent.key);
      superseded.discard?.();
      coalescedReactions.push(pane.collaboration.reactions.get("message-1"));
    }
    deferred.set(intent.key, intent);
    gateway.snapshot.deferredIntentCount = deferred.size;
    return true;
  };
  const connect = (connected: boolean) => {
    gateway.snapshot.phase = connected ? "connected" : "reconnecting";
    pane.applyGatewaySnapshot(gateway.snapshot);
  };
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
  const commitHistory = () =>
    setChatHistoryLoad(created.state, {
      phase: "committed",
      sessions: created.state.sessions,
      client,
      connectionEpoch: created.state.connectionEpoch,
      sessionKey: created.state.sessionKey,
      requestAgentId: undefined,
      sessionInfo: { key: created.state.sessionKey, sessionId: "session-1", kind: "direct" },
    });
  commitHistory();
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
  return {
    ...created,
    pane,
    session,
    commitHistory,
    event,
    requests,
    writes,
    deferred,
    coalescedReactions,
    connect,
    client,
    react: (remove = false) => pane.setMessageReaction("message-1", "🎉", remove),
    reactions: () => pane.collaboration.reactions.get("message-1"),
    replay: async (replayClient = client) => {
      const pending = deferred.values().next().value;
      assert(pending);
      await pending.run(replayClient);
    },
  };
}

describe("pane reaction ownership", () => {
  it("defers the baseline until transcript readiness while publishing live reactions", async () => {
    const list = createDeferred<SessionReactionsListResult>();
    const f = fixture(list.promise);
    setChatHistoryLoad(f.state, {
      phase: "pending-connection",
      sessionKey: f.state.sessionKey,
      requestAgentId: undefined,
      startup: true,
    });
    f.pane.syncSessionReactions();
    f.pane.handleSessionReactionEvent(f.event());
    expect(f.requests).toEqual([]);
    expect(f.reactions()).toEqual(peerReaction);
    f.commitHistory();
    f.pane.syncSessionReactions();
    expect(f.requests).toEqual(["session.reactions.list"]);
    list.resolve({ sessionId: "session-1", reactions: { "message-1": peerReaction } });
    await list.promise;
    await Promise.resolve();
    expect(f.reactions()).toEqual(peerReaction);
  });

  it.each(["list", "set"] as const)(
    "retains live events over an older %s response",
    async (operation) => {
      const list = createDeferred<SessionReactionsListResult>();
      const set = createDeferred<SessionReactionsSetResult>();
      const { pane, event, requests } = fixture(list.promise, set.promise);
      pane.syncSessionReactions();
      pane.syncSessionReactions();
      let write: Promise<void> | undefined;
      if (operation === "set") {
        list.resolve({ sessionId: "session-1", reactions: {} });
        await list.promise;
        await Promise.resolve();
        await Promise.resolve();
        write = pane.setMessageReaction("message-1", "🎉", false);
      }
      pane.handleSessionReactionEvent(event());
      list.resolve({ sessionId: "session-1", reactions: {} });
      set.resolve({ messageId: "message-1", reactions: [] });
      await write;
      await list.promise;
      await Promise.resolve();
      await Promise.resolve();
      expect(requests).toEqual(
        operation === "set"
          ? ["session.reactions.list", "session.reactions.set"]
          : ["session.reactions.list"],
      );
      expect(pane.collaboration.reactions.get("message-1")).toEqual(peerReaction);
    },
  );

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
    expect(pane.collaboration.reactions.size).toBe(0);
  });

  it.each([false, true])("retains offline reactions on replacement=%s", async (replace) => {
    const f = fixture(
      Promise.resolve({ sessionId: "session-1", reactions: {} }),
      Promise.resolve({ messageId: "message-1", reactions: selfReaction }),
    );
    const { pane, event, connect, deferred, writes, coalescedReactions, client } = f;
    connect(true);
    pane.handleSessionReactionEvent(event());
    connect(false);
    await f.react();
    expect(f.reactions()).toEqual([...peerReaction, ...selfReaction]);
    await f.react(true);
    expect(f.reactions()).toEqual(peerReaction);
    await f.react();
    expect(coalescedReactions).toEqual([peerReaction, [...peerReaction, ...selfReaction]]);
    expect(deferred.size).toBe(1);
    expect(writes).toEqual([]);
    const hello = pane.context.gateway.snapshot.hello;
    const replayClient = replace ? createTestGatewayClient(client.request.bind(client)) : client;
    if (replace) {
      pane.context.gateway.snapshot.client = replayClient;
      pane.context.gateway.snapshot.hello = null;
      connect(false);
      pane.syncSessionReactions();
      expect(f.reactions()).toEqual([...peerReaction, ...selfReaction]);
    }
    pane.context.gateway.snapshot.hello = hello;
    connect(true);
    await f.react(true);
    await f.react();
    expect(writes).toEqual([]);
    await f.replay(replayClient);
    expect(writes).toEqual([
      {
        sessionKey: "agent:main:current",
        messageId: "message-1",
        emoji: "🎉",
        remove: false,
      },
    ]);
    expect(f.reactions()).toEqual(selfReaction);
    pane.handleSessionReactionEvent(event());
    expect(f.reactions()).toEqual(peerReaction);
  });

  it("queues a reaction while the owner reports its final deferred request in flight", async () => {
    const { pane, connect, deferred, writes, react, replay } = fixture(
      Promise.resolve({ sessionId: "session-1", reactions: {} }),
      Promise.resolve({ messageId: "message-1", reactions: [] }),
    );
    connect(true);
    pane.context.gateway.snapshot.deferredIntentDraining = true;
    await react();
    expect(writes).toEqual([]);
    expect(deferred.size).toBe(1);
    await replay();
    expect(writes).toHaveLength(1);
  });

  it.each(["discard", "reject", "decline"] as const)(
    "restores server-known reactions on offline intent %s",
    async (outcome) => {
      const rejected = createDeferred<SessionReactionsSetResult>();
      const { pane, event, connect, deferred, client } = fixture(
        Promise.resolve({ sessionId: "session-1", reactions: { "message-1": peerReaction } }),
        rejected.promise,
      );
      connect(true);
      pane.handleSessionReactionEvent(event());
      connect(false);
      if (outcome === "decline") {
        pane.context.gateway.defer = () => false;
      }
      await pane.setMessageReaction("message-1", "👍", false);
      const pending = [...deferred.values()][0];
      if (outcome === "discard") {
        assert(pending);
        pending.discard?.();
      } else if (outcome === "reject") {
        assert(pending);
        connect(true);
        const write = pending.run(client);
        rejected.reject(new Error("reaction denied"));
        await write;
        expect(pane.state.chatError).toBe("reaction denied");
      }
      expect(pane.collaboration.reactions.get("message-1")).toEqual(peerReaction);
    },
  );

  it.each(["same", "replacement client", "replacement scope"] as const)(
    "%s: reports a departed session's deferred failure only while its Gateway owner is current",
    async (owner) => {
      const showToast = vi.spyOn(toast, "showToast").mockReturnValue(true);
      onTestFinished(() => showToast.mockRestore());
      const failed = createDeferred<SessionReactionsSetResult>();
      const { pane, session, connect, deferred, client } = fixture(
        Promise.resolve({ sessionId: "session-1", reactions: {} }),
        failed.promise,
      );
      connect(true);
      connect(false);
      await pane.setMessageReaction("message-1", "🎉", false);
      connect(true);
      pane.state.sessionKey = "agent:main:next";
      session("session-2");
      pane.syncSessionReactions();
      const pending = deferred.values().next().value;
      assert(pending);
      const replay = pending.run(client);
      if (owner === "replacement client") {
        pane.context.gateway.snapshot.client = createTestGatewayClient(() => ({}));
      } else if (owner === "replacement scope") {
        Object.defineProperty(client, "recoveryScope", { get: () => "replacement-scope" });
      }
      failed.reject(new Error("reaction denied"));
      await replay;
      expect(showToast.mock.calls).toEqual(
        owner === "same" ? [[{ message: "reaction denied" }]] : [],
      );
      expect(pane.state.chatError).toBeNull();
      expect(pane.state.lastError).toBeNull();
      expect(pane.collaboration.reactions.size).toBe(0);
    },
  );
});
