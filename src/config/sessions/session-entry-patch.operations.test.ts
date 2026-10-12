import "./session-entry-patch-delivery.test-support.js";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import { readConversation, registerConversationAddresses } from "./conversation-registry.js";
import { resolveConversationRouteFingerprint } from "./conversation-route-fingerprint.js";
import {
  applySessionEntryOperation,
  recordInboundSessionMeta,
  replaceSessionEntrySync,
  updateSessionLastRouteInScope,
} from "./session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import type { SessionEntry } from "./types.js";

const { getSessionEntryPatchDelivery } =
  await import("./session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();

it.each(["inbound", "route"] as const)(
  "merges %s metadata with an in-process write without a detached comparison read",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const original = f.read()!;
      delivery.beforeCommit = () => {
        delivery.beforeCommit = undefined;
        replaceSessionEntrySync(f.scope, {
          ...original,
          label: "concurrent label",
          updatedAt: original.updatedAt + 100,
          delivery: {
            kind: "external",
            route: {
              channel: "reef",
              target: { to: "user:existing" },
              thread: { id: "old-thread" },
            },
            context: { channel: "reef", to: "user:existing", threadId: "old-thread" },
            origin: { provider: "reef", to: "user:existing", threadId: "old-thread" },
          },
        });
      };
      const ctx = { Provider: "reef", From: "reef:alice", ChatType: "direct", SenderName: "Alice" };
      const result =
        kind === "inbound"
          ? await recordInboundSessionMeta({ ...f.scope, ctx })
          : await updateSessionLastRouteInScope(f.scope, {
              channel: "reef",
              to: "user:alice",
              ctx,
            });
      expect(result).toMatchObject({
        label: "concurrent label",
        updatedAt: original.updatedAt + 100,
      });
      expect(result).toMatchObject({ delivery: { origin: { label: "Alice" } } });
      expect(f.read()).toEqual(result);
      expect(delivery.commands).toEqual(["session.entry.patch.commit"]);
    });
  },
);

it("reduces a fixed patch against the current row in one worker request without losing foreign metadata", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const original = f.read()!;
    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      replaceSessionEntrySync(f.scope, { ...original, compactionCount: 4, label: "foreign edit" });
    };
    const published: SessionEntry[] = [];
    const result = await applySessionEntryOperation(
      f.scope,
      {
        kind: "compaction-accounting",
        expected: {
          sessionId: original.sessionId,
          lifecycleRevision: original.lifecycleRevision,
          activeWriterRunId: original.activeWriterRunId,
        },
        accounting: { amount: 2, tokensAfter: 123 },
      },
      { skipMaintenance: true, onCommitted: (entry) => published.push(entry) },
    );
    expect(delivery.commands.length).toBeLessThanOrEqual(1);
    expect(result).toMatchObject({ compactionCount: 6, totalTokens: 123, label: "foreign edit" });
    expect(f.read()).toEqual(result);
    expect(published).toEqual([result]);

    const current = f.read()!;
    for (const expected of [
      { sessionId: "retired" },
      { sessionId: current.sessionId, lifecycleRevision: "retired" },
      { sessionId: current.sessionId, activeWriterRunId: "retired" },
    ]) {
      const unchanged = await applySessionEntryOperation(
        f.scope,
        { kind: "compaction-accounting", expected, accounting: { amount: 10 } },
        { skipMaintenance: true, onCommitted: (entry) => published.push(entry) },
      );
      expect(unchanged).toEqual(current);
      expect(f.read()).toEqual(current);
    }
    expect(published).toEqual([result]);
  });
});

it("rechecks conversation authority before a fixed patch commits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "patch-peer",
      deliveryTarget: "user:patch-peer",
    })!;
    await registerConversationAddresses(f.scope, [identity]);
    const conversation = (await readConversation(f.scope, identity.conversationRef))!;
    const workerGuard = {
      conversation: {
        conversationRef: identity.conversationRef,
        expectedRouteFingerprint: resolveConversationRouteFingerprint(conversation),
      },
    };
    const onCommitted = vi.fn();
    const accepted = await applySessionEntryOperation(
      f.scope,
      { kind: "fields", patch: { label: "authorized" } },
      { skipMaintenance: true, workerGuard, onCommitted },
    );
    expect(accepted).toMatchObject({ label: "authorized" });
    expect(f.read()).toEqual(accepted);
    expect(onCommitted).toHaveBeenCalledExactlyOnceWith(accepted);
    onCommitted.mockClear();

    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      const foreign = new (requireNodeSqlite().DatabaseSync)(f.database.path);
      try {
        foreign
          .prepare("UPDATE conversations SET delivery_target = ? WHERE conversation_id = ?")
          .run("user:replacement", identity.conversationRef);
      } finally {
        foreign.close();
      }
    };
    await expect(
      applySessionEntryOperation(
        f.scope,
        { kind: "fields", patch: { label: "must not persist" } },
        { skipMaintenance: true, workerGuard, onCommitted },
      ),
    ).rejects.toThrow("Conversation is no longer available");
    expect(f.read()).toEqual(accepted);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(await readConversation(f.scope, identity.conversationRef)).toMatchObject({
      target: "user:replacement",
    });
  });
});

it("retains typed source and conversation authority when updating the last route", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const identity = buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId: "route-peer",
      deliveryTarget: "user:route-peer",
    })!;
    await registerConversationAddresses(f.scope, [identity]);
    const conversation = (await readConversation(f.scope, identity.conversationRef))!;
    let sourceCurrent = true;
    const refusal = new Error("route source was revoked");
    const source = captureSessionEntrySourceAssertion({
      scope: f.scope,
      expected: f.read(),
      fields: ["sessionId"],
      assertCurrent() {
        throw new Error("typed route source must use its prepared authority");
      },
      assertHostCurrent() {
        if (!sourceCurrent) {
          throw refusal;
        }
      },
      refuse() {
        throw refusal;
      },
    });
    const updateRoute = () =>
      updateSessionLastRouteInScope(f.scope, {
        channel: "reef",
        to: "user:route-peer",
        assertCommitAllowed: source,
        workerGuard: {
          conversation: {
            conversationRef: identity.conversationRef,
            expectedRouteFingerprint: resolveConversationRouteFingerprint(conversation),
          },
        },
      });
    const accepted = await updateRoute();
    expect(accepted).toMatchObject({
      delivery: { route: { channel: "reef", target: { to: "user:route-peer" } } },
    });

    sourceCurrent = false;
    await expect(updateRoute()).rejects.toBe(refusal);
    expect(f.read()).toEqual(accepted);
    sourceCurrent = true;
    delivery.beforeCommit = () => {
      delivery.beforeCommit = undefined;
      const foreign = new (requireNodeSqlite().DatabaseSync)(f.database.path);
      try {
        foreign
          .prepare("UPDATE conversations SET delivery_target = ? WHERE conversation_id = ?")
          .run("user:replacement", identity.conversationRef);
      } finally {
        foreign.close();
      }
    };
    await expect(updateRoute()).rejects.toThrow("Conversation is no longer available");
    expect(f.read()).toEqual(accepted);
  });
});
