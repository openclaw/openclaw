import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import { withAgentDatabaseCloseFence } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  readConversation,
  resolveCurrentConversationByDelivery,
  resolveCurrentSessionPrimaryConversation,
  withConversationAuthority,
} from "./conversation-registry.js";
import {
  commitReplySessionInitialization,
  deleteSessionEntryLifecycle,
  loadReplySessionInitializationSnapshot,
  upsertSessionEntryCore as upsertSessionEntry,
} from "./session-accessor.js";
import {
  conversationPublication,
  type ConversationPublication,
} from "./session-accessor.sqlite-conversation-publication.js";
import {
  linkSessionConversation,
  prepareConversationIdentities,
  upsertConversationIdentities,
} from "./session-accessor.sqlite-conversation.js";
import {
  getSessionKysely,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionEntry } from "./types.js";

describe("conversation registry", () => {
  let tempDir: string;
  let storePath: string;
  const subscriptions: (() => void)[] = [];
  const observe = (unsubscribe: () => void) => subscriptions.push(unsubscribe);
  const watchFacts = (onReceipt = () => {}) => {
    const receipts: ConversationPublication[] = [];
    observe(
      conversationPublication.subscribeFacts((receipt) => {
        if ("facts" in receipt) {
          receipts.push(receipt);
          onReceipt();
        }
      }),
    );
    return receipts;
  };

  const registryScope = () => ({ agentId: "main", storePath });
  const sessionScope = (sessionKey: string) => ({ ...registryScope(), sessionKey });
  const read = (ref: string) => readConversation(registryScope(), ref);
  const list = (options: Parameters<typeof listConversations>[1] = {}) =>
    listConversations(registryScope(), options);
  const primary = (
    scope: Omit<Parameters<typeof resolveCurrentSessionPrimaryConversation>[0], "sessionId">,
    sessionId: string,
  ) => resolveCurrentSessionPrimaryConversation({ ...scope, sessionId });
  const expectUnbound = (record: Awaited<ReturnType<typeof read>>) => {
    expect(record).toBeDefined();
    expect([record?.sessionId, record?.sessionKey, record?.role]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  };
  const routedEntry = (
    sessionId: string,
    to: string,
    channel = "reef",
    updatedAt = 100,
  ): SessionEntry => ({
    sessionId,
    updatedAt,
    chatType: channel === "reef" ? "direct" : "channel",
    delivery: {
      kind: "external",
      route: { channel, accountId: "default", target: { to } },
      context: { channel, accountId: "default", to },
      origin: { provider: channel, accountId: "default", to },
    },
  });
  const address = (
    peerId: string,
    deliveryTarget = peerId,
    options: Partial<Parameters<typeof buildConversationIdentity>[0]> = {},
  ) =>
    buildConversationIdentity({
      channel: "reef",
      accountId: "default",
      kind: "direct",
      peerId,
      deliveryTarget,
      ...options,
    });
  type InitializationOptions = {
    routeContext?: Parameters<typeof commitReplySessionInitialization>[0]["routeContext"];
    entry?: Partial<SessionEntry>;
  };
  async function commitInitialization(
    scope: { agentId: string; sessionKey: string; storePath: string },
    { entry, ...options }: InitializationOptions = {},
  ) {
    const snapshot = await loadReplySessionInitializationSnapshot(scope);
    const result = await commitReplySessionInitialization({
      ...scope,
      activeSessionKey: scope.sessionKey,
      expectedRevision: snapshot.revision,
      snapshotEntry: snapshot.currentEntry,
      sessionEntry: { ...snapshot.currentEntry!, ...entry },
      ...options,
    });
    expect(result.ok).toBe(true);
  }
  const seed = async (peer = "peer-a", channel = "reef", sessionId = `${peer}-session`) => {
    const kind = channel === "reef" ? "direct" : "channel";
    const scope = sessionScope(`agent:main:${channel}:${kind}:${peer}`);
    await upsertSessionEntry(
      scope,
      routedEntry(sessionId, `${channel === "reef" ? "reef" : "channel"}:${peer}`, channel),
    );
    return scope;
  };
  const openDatabase = (scope: Parameters<typeof resolveSqliteReadScope>[0]) =>
    openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
  const reopenDatabase = async (scope: Parameters<typeof resolveSqliteReadScope>[0]) => {
    await closeOpenClawAgentDatabasesAsync(tempDir);
    return openDatabase(scope);
  };
  const changeRows = async (
    query: (
      db: ReturnType<typeof getSessionKysely>,
    ) => Parameters<typeof executeSqliteQuerySync>[1],
  ) => {
    const database = await reopenDatabase(registryScope());
    return executeSqliteQuerySync(database.db, query(getSessionKysely(database.db)));
  };
  const tempDirs = createTempDirTracker();
  afterEach(async () => {
    for (const unsubscribe of subscriptions.splice(0)) {
      unsubscribe();
    }
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
      closeOpenClawAgentDatabasesForTest(dir);
    }
    tempDirs.cleanup();
  });

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-conversations-");
    storePath = path.join(tempDir, "sessions.json");
  });

  it("catalogs a directory address without inventing a model-context session", async () => {
    const identity = address("reef:peer-a", undefined, { nativeDirectUserId: "peer-a" });
    await registerConversationAddresses(registryScope(), [identity!], 100);
    const second = address("peer-b", "reef:peer-b");
    const label = "last\u0000literal\\u0000";
    await registerConversationAddresses(
      registryScope(),
      [identity!, second!, { ...identity!, label, nativeDirectUserId: undefined }],
      200,
    );
    const updated = await read(identity!.conversationRef);
    expect(updated).toMatchObject({
      target: "reef:peer-a",
      label,
      firstSeenAt: 100,
      lastSeenAt: 200,
    });
    expect(updated?.nativeDirectUserId).toBeUndefined();
    expectUnbound(updated);
    expect(await read(second!.conversationRef)).toMatchObject({
      target: "reef:peer-b",
      firstSeenAt: 200,
      lastSeenAt: 200,
    });
  });

  it.each(["registration", "authority"] as const)(
    "releases %s resources when a queued database target is replaced",
    async (operation) => {
      const databasePath = path.join(tempDir, "registry.sqlite");
      fs.writeFileSync(databasePath, "");
      const scope = {
        agentId: "main",
        databaseAgentId: "main",
        storePath: databasePath,
        env: { OPENCLAW_STATE_DIR: tempDir },
      };
      const entered = createDeferred();
      const release = createDeferred();
      const held = runOpenClawAgentWorkerWrite(
        { agentId: "main", path: databasePath, env: scope.env },
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      let pending: Promise<unknown> | undefined;
      try {
        await awaitGateBeforeSettlement(entered.promise, held, "Writer did not acquire its lane");
        const identity = address("peer-a", "reef:peer-a", { accountId: undefined });
        pending =
          operation === "registration"
            ? registerConversationAddresses(scope, [identity!])
            : withConversationAuthority(
                scope,
                { conversationRef: identity!.conversationRef },
                () => {
                  throw new Error("A replaced target must not grant conversation authority");
                },
              );
        const rejected = expect(pending).rejects.toThrow(
          "Agent database target changed before write admission",
        );
        fs.renameSync(databasePath, `${databasePath}.previous`);
        fs.writeFileSync(databasePath, "");
        release.resolve();
        await rejected;
        await held;
        await withAgentDatabaseCloseFence({ path: databasePath }, async (resources) => {
          expect(resources).toEqual([]);
        });
      } finally {
        release.resolve();
        await Promise.allSettled([held, pending]);
      }
    },
  );

  it("rejects an empty conversation reference instead of widening the lookup", async () => {
    const identity = address("reef:peer-b");
    await registerConversationAddresses(registryScope(), [identity!], 100);

    for (const conversationRef of ["", "   "]) {
      await expect(read(conversationRef)).rejects.toThrow(/Invalid conversationRef/);
    }
  });

  it("finds only the live owner matching every delivery coordinate", async () => {
    const scope = { agentId: "main", storePath };
    const sessionKey = "agent:main:googlechat:group:space-a";
    const delivery = {
      channel: "googlechat",
      accountId: "work",
      target: "spaces/space-a",
      threadId: "thread-a",
    };
    await upsertSessionEntry(
      { ...scope, sessionKey },
      {
        sessionId: "space-session",
        updatedAt: 100,
        chatType: "group",
        delivery: {
          kind: "external",
          route: {
            channel: delivery.channel,
            accountId: delivery.accountId,
            target: { to: delivery.target },
            thread: { id: delivery.threadId },
          },
          context: {
            channel: delivery.channel,
            accountId: delivery.accountId,
            to: delivery.target,
            threadId: delivery.threadId,
          },
          origin: {
            provider: delivery.channel,
            accountId: delivery.accountId,
            to: delivery.target,
          },
        },
      },
    );
    expect(await resolveCurrentConversationByDelivery(scope, delivery)).toMatchObject({
      conversation: { sessionKey, sessionId: "space-session", kind: "group" },
    });
    for (const changed of [
      { channel: "slack" },
      { accountId: "personal" },
      { target: "spaces/space-b" },
      { threadId: "thread-b" },
      { threadId: undefined },
    ]) {
      expect(
        await resolveCurrentConversationByDelivery(scope, { ...delivery, ...changed }),
      ).toEqual({ conversation: undefined });
    }
  });

  it("reports ambiguous live owners instead of selecting the newest session", async () => {
    const scope = { agentId: "main", storePath };
    const delivery = { channel: "googlechat", accountId: "default", target: "spaces/shared" };
    for (const index of [1, 2]) {
      await upsertSessionEntry(
        { ...scope, sessionKey: `agent:main:shared-${index}` },
        {
          sessionId: `shared-session-${index}`,
          updatedAt: index * 100,
          chatType: "group",
          delivery: {
            kind: "external",
            route: {
              channel: delivery.channel,
              accountId: delivery.accountId,
              target: { to: delivery.target },
            },
            context: {
              channel: delivery.channel,
              accountId: delivery.accountId,
              to: delivery.target,
            },
            origin: {
              provider: delivery.channel,
              accountId: delivery.accountId,
              to: delivery.target,
            },
          },
        },
      );
    }
    expect(await resolveCurrentConversationByDelivery(scope, delivery)).toEqual({
      ambiguous: true,
    });
  });

  it("round-trips authoritative route context on its conversation association", async () => {
    const scope = await seed("ops", "discord");
    const routeContext = {
      peerId: "canonical-ops",
      guildId: "guild-a",
      parentPeerId: "parent-a",
      memberRoleIds: ["support", "admin"],
    };
    // Keep observation times explicit; bookkeeping clamps future activity to its wall clock.
    await commitInitialization(scope, { routeContext, entry: { updatedAt: 100 } });
    const canonicalConversation = (await list()).find(
      (conversation) => conversation.peerId === "canonical-ops",
    );
    const conversationRef = canonicalConversation!.conversationRef;
    expect(await primary(scope, "ops-session")).toEqual(canonicalConversation);
    expect(await primary(scope, "another-session")).toBeUndefined();
    expect(
      await primary({ ...scope, sessionKey: "agent:main:discord:channel:another" }, "ops-session"),
    ).toBeUndefined();
    expect(await read(conversationRef)).toMatchObject({
      peerId: "canonical-ops",
      observedFromSession: true,
      routeContextObserved: true,
      routeContext: { ...routeContext, memberRoleIds: ["admin", "support"] },
    });

    await commitInitialization(scope, { entry: { updatedAt: 200 } });
    const resumed = await read(conversationRef);
    expect(resumed!.lastSeenAt).toBe(200);
    expect(resumed).toEqual({ ...canonicalConversation, lastSeenAt: resumed!.lastSeenAt });

    await upsertSessionEntry(scope, {
      totalTokens: 42,
      updatedAt: 300,
    });
    expect(await read(conversationRef)).toEqual(resumed);
    expect(await primary(scope, "ops-session")).toEqual(resumed);

    await commitInitialization(scope, {
      routeContext: { peerId: "canonical-ops", guildId: "guild-b" },
      entry: { updatedAt: 400 },
    });
    const observed = await read(conversationRef);
    expect(observed).toMatchObject({ routeContext: { guildId: "guild-b" } });
    expect(observed!.lastSeenAt).toBe(400);

    await upsertSessionEntry(scope, { label: "generic current write", updatedAt: 200 });
    expect((await list()).filter((conversation) => conversation.role === "primary")).toEqual([
      expect.objectContaining({ conversationRef, peerId: "canonical-ops" }),
    ]);
    const afterCurrentWrite = await read(conversationRef);
    expect(afterCurrentWrite).toMatchObject({
      label: "generic current write",
      routeContextObserved: true,
      routeContext: { guildId: "guild-b" },
    });

    const updatedAssociation = await changeRows((db) =>
      db
        .updateTable("session_conversations")
        .set({ last_seen_at: afterCurrentWrite!.lastSeenAt })
        .where("session_id", "=", "ops-session")
        .where("conversation_id", "=", conversationRef)
        .where("role", "=", "primary"),
    );
    expect(Number(updatedAssociation.numAffectedRows)).toBe(1);
    await closeOpenClawAgentDatabasesAsync(tempDir);
    closeOpenClawAgentDatabasesForTest();

    expect(await read(conversationRef)).not.toMatchObject({ routeContextObserved: true });
    const unobserved = await primary(scope, "ops-session");
    expect(unobserved).toMatchObject({
      conversationRef,
      sessionId: "ops-session",
      role: "primary",
    });
    expect(unobserved?.routeContext).toBeUndefined();
    await upsertSessionEntry(scope, {
      label: "after older writer",
      updatedAt: afterCurrentWrite!.lastSeenAt + 1,
    });
    expect(await read(conversationRef)).not.toMatchObject({ routeContextObserved: true });
  });

  it("keeps route context with each conversation when a shared session changes primary", async () => {
    const scope = sessionScope("agent:main:discord:channel:shared");
    const writeRoute = async (target: string, guildId: string, updatedAt: number) => {
      await upsertSessionEntry(scope, routedEntry("shared-session", target, "discord", updatedAt));
      await commitInitialization(scope, { routeContext: { guildId } });
    };

    await writeRoute("channel:alpha", "guild-alpha", 100);
    await writeRoute("channel:beta", "guild-beta", 200);

    expect(
      (await list({ channel: "discord" }))
        .map(({ target, routeContext }) => ({ target, routeContext }))
        .toSorted((left, right) => left.target.localeCompare(right.target)),
    ).toEqual([
      { target: "channel:alpha", routeContext: { guildId: "guild-alpha" } },
      { target: "channel:beta", routeContext: { guildId: "guild-beta" } },
    ]);
    await changeRows((db) =>
      db
        .updateTable("session_conversations")
        .set({ last_seen_at: 500 })
        .where("session_id", "=", "shared-session")
        .where("role", "=", "related"),
    );
    expect(await primary(scope, "shared-session")).toMatchObject({
      target: "channel:beta",
      routeContext: { guildId: "guild-beta" },
    });
  });

  it("preserves context across an unobserved rollover and clears it on observed-empty ingress", async () => {
    const scope = await seed("rollover", "discord", "before-rollover");
    const routeContext = { guildId: "guild-a", memberRoleIds: ["support"] };
    await commitInitialization(scope, { routeContext });
    await commitInitialization(scope, { entry: { sessionId: "after-rollover", updatedAt: 200 } });
    expect((await list())[0]).toMatchObject({
      sessionId: "after-rollover",
      routeContextObserved: true,
      routeContext,
    });
    expect(await primary(scope, "before-rollover")).toBeUndefined();
    expect(await primary(scope, "after-rollover")).toMatchObject({
      routeContext: { guildId: "guild-a" },
    });

    await commitInitialization(scope, { routeContext: null });
    const cleared = (await list())[0];
    expect(cleared).toMatchObject({
      sessionId: "after-rollover",
      routeContextObserved: true,
    });
    expect(cleared?.routeContext).toBeUndefined();
    expect((await primary(scope, "after-rollover"))?.routeContext).toBeUndefined();
  });

  it.each([
    { entry_valid: 0 },
    { entry_json: JSON.stringify({ sessionId: "wrong-session", updatedAt: 100 }) },
  ])("does not bind an invalid current entry to its primary address: %j", async (invalid) => {
    const scope = await seed();
    await changeRows((db) =>
      db.updateTable("session_nodes").set(invalid).where("session_key", "=", scope.sessionKey),
    );
    expect(await primary(scope, "peer-a-session")).toBeUndefined();
    if (invalid.entry_json !== undefined) {
      const [conversation] = await list();
      expect(conversation).toMatchObject({ target: "reef:peer-a" });
      expect([conversation?.sessionId, conversation?.sessionKey]).toEqual([undefined, undefined]);
    }
  });

  it("orders fresh directory addresses with session-backed conversation activity", async () => {
    await seed();
    const freshIdentity = address("reef:peer-b");
    const freshAt = Date.now() + 1_000;
    await registerConversationAddresses(registryScope(), [freshIdentity!], freshAt);

    expect(await list({ channel: "reef", limit: 1 })).toEqual([
      expect.objectContaining({
        conversationRef: freshIdentity?.conversationRef,
        target: "reef:peer-b",
        lastSeenAt: freshAt,
      }),
    ]);
  });

  it("keeps a live binding when newer historical activity has no current entry", async () => {
    const liveSessionKey = "agent:main:reef:direct:peer-a-live";
    const staleSessionKey = "agent:main:reef:direct:peer-a-stale";
    for (const [sessionKey, sessionId] of [
      [liveSessionKey, "live-session"],
      [staleSessionKey, "stale-session"],
    ] as const) {
      await upsertSessionEntry(sessionScope(sessionKey), routedEntry(sessionId, "reef:peer-a"));
    }
    const database = await reopenDatabase(registryScope());
    const db = getSessionKysely(database.db);
    for (const [sessionId, lastSeenAt] of [
      ["live-session", 100],
      ["stale-session", 200],
    ] as const) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_conversations")
          .set({ last_seen_at: lastSeenAt })
          .where("session_id", "=", sessionId),
      );
    }
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("session_nodes").where("session_key", "=", staleSessionKey),
    );

    expect((await list({ channel: "reef", limit: 1 }))[0]).toMatchObject({
      target: "reef:peer-a",
      sessionId: "live-session",
      sessionKey: liveSessionKey,
      lastSeenAt: 100,
    });
  });

  it("retains a deleted session's address without exposing a stale binding", async () => {
    const scope = await seed("peer-a", "reef", "deleted-session");
    const [linked] = await list({ channel: "reef" });

    await deleteSessionEntryLifecycle({
      ...registryScope(),
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      archiveTranscript: false,
    });
    expect(await primary(scope, "deleted-session")).toBeUndefined();

    const retained = await read(linked?.conversationRef ?? "missing");
    expect(retained).toMatchObject({
      conversationRef: linked?.conversationRef,
      target: "reef:peer-a",
    });
    expectUnbound(retained);
  });

  it("keeps native association roles and publications atomic across rollback", async () => {
    const scope = sessionScope("agent:main:receipt");
    const sessionId = "receipt-session";
    await upsertSessionEntry(scope, { sessionId, updatedAt: 1 });
    const options = toDatabaseOptions(resolveSqliteReadScope(scope));
    const identities = ["first", "second"].map((peerId) =>
      address(peerId, undefined, { channel: "fixture", kind: "channel" })!,
    );
    const write = (index: number, updatedAt: number, routeContext?: { guildId: string }) =>
      runOpenClawAgentWriteTransaction((database) => {
        const identity = identities[index]!;
        upsertConversationIdentities(
          database,
          prepareConversationIdentities([identity]),
          updatedAt,
        );
        linkSessionConversation({
          database,
          sessionId,
          conversation: { identity, role: "primary", routeContext },
          updatedAt,
        });
      }, options);
    write(0, 10);
    const receipts = watchFacts();
    write(1, 20, { guildId: "receipt-guild" });
    expect(await read(identities[0]!.conversationRef)).toMatchObject({
      role: "related",
      lastSeenAt: 20,
    });
    expect(await read(identities[1]!.conversationRef)).toMatchObject({
      role: "primary",
      lastSeenAt: 20,
      routeContext: { guildId: "receipt-guild" },
    });
    const committedReceipts = [...receipts];
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        write(0, 30);
        throw new Error("rollback conversation");
      }, options),
    ).toThrow("rollback conversation");
    expect(receipts).toEqual(committedReceipts);
    expect(await read(identities[1]!.conversationRef)).toHaveProperty("role", "primary");
  });

  it("publishes binding facts without transporting large catalogue metadata", async () => {
    const scope = registryScope();
    const identity = address("large-catalogue", undefined, { channel: "fixture" })!;
    // The request fits IPC; JSON's six-byte escape expands the stored postimage beyond it.
    identity.metadata = {
      payload: "\0".repeat(Math.floor(SQLITE_WORKER_MAX_MESSAGE_BYTES / 6) + 1),
    };
    const events: string[] = [];
    const receipts = watchFacts(() => {
      events.push("facts");
    });
    await expect(registerConversationAddresses(scope, [identity], 100)).resolves.toBeUndefined();
    events.push("reply");
    const database = openDatabase(scope);
    expect(
      database.db
        .prepare(
          "SELECT length(metadata_json) AS bytes, updated_at FROM conversations WHERE conversation_id = ?",
        )
        .get(identity.conversationRef),
    ).toEqual({
      bytes: JSON.stringify(identity.metadata).length,
      updated_at: 100,
    });
    expect(events).toEqual(["facts", "reply"]);
    expect(receipts).toHaveLength(1);
  });
});
