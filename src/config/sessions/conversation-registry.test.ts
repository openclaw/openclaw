import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import { normalizeLegacySessionEntryDelivery } from "../../infra/state-migrations.legacy-session-store.js";
import { withAgentDatabaseCloseFence } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { buildConversationIdentity } from "./conversation-identity.js";
import {
  listConversations,
  registerConversationAddresses,
  readConversation,
  resolveCurrentSessionPrimaryConversation,
  withConversationAuthority,
} from "./conversation-registry.js";
import {
  commitReplySessionInitialization,
  deleteSessionEntryLifecycle,
  loadReplySessionInitializationSnapshot,
  upsertSessionEntryCore as upsertCanonicalSessionEntry,
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

type LegacyDeliveryFixture = Partial<SessionEntry> & {
  deliveryContext?: DeliveryContext;
};

const upsertSessionEntry = (
  scope: Parameters<typeof upsertCanonicalSessionEntry>[0],
  entry: LegacyDeliveryFixture,
) => upsertCanonicalSessionEntry(scope, normalizeLegacySessionEntryDelivery(entry as SessionEntry));

describe("conversation registry", () => {
  let tempDir: string;
  let storePath: string;
  const subscriptions: (() => void)[] = [];
  const observe = (unsubscribe: () => void) => subscriptions.push(unsubscribe);
  const expectPostimage = (fact: unknown, row: unknown, kind?: string) =>
    expect(fact).toMatchObject({ kind: "postimage", value: { ...(kind ? { kind } : {}), row } });

  const registryScope = () => ({ agentId: "main", storePath });
  const sessionScope = (sessionKey: string) => ({ ...registryScope(), sessionKey });
  const read = (ref: string) => readConversation(registryScope(), ref);
  const primary = (
    scope: Omit<Parameters<typeof resolveCurrentSessionPrimaryConversation>[0], "sessionId">,
    sessionId: string,
  ) => resolveCurrentSessionPrimaryConversation({ ...scope, sessionId });
  const routedEntry = (
    sessionId: string,
    to: string,
    channel = "reef",
    updatedAt = 100,
  ): LegacyDeliveryFixture => ({
    sessionId,
    updatedAt,
    chatType: channel === "reef" ? "direct" : "channel",
    deliveryContext: { channel, accountId: "default", to },
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
    const identity = address("reef:peer-a", undefined, {
      nativeDirectUserId: "peer-a",
      label: "@peer-a's agent",
    });
    const receipts: ConversationPublication[] = [];
    observe(
      conversationPublication.subscribeFacts((receipt) => {
        if ("facts" in receipt) {
          receipts.push(receipt);
        }
      }),
    );
    await registerConversationAddresses(registryScope(), [identity!], 100);
    expect(receipts).toHaveLength(1);
    expectPostimage(
      receipts[0]?.facts.get(JSON.stringify(["catalogue", identity!.conversationRef])),
      {
        conversation_id: identity!.conversationRef,
        kind: identity!.kind,
      },
      "catalogue",
    );

    const [conversation] = await listConversations(registryScope(), { channel: "reef" });
    expect(conversation).toMatchObject({
      conversationRef: identity?.conversationRef,
      target: "reef:peer-a",
      label: "@peer-a's agent",
      firstSeenAt: 100,
      lastSeenAt: 100,
    });
    expect([conversation?.sessionId, conversation?.sessionKey, conversation?.role]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(await read(identity!.conversationRef)).toEqual(conversation);

    const second = address("peer-b", "reef:peer-b");
    const label = "last\u0000literal\\u0000";
    await registerConversationAddresses(
      registryScope(),
      [identity!, second!, { ...identity!, label, nativeDirectUserId: undefined }],
      200,
    );
    const updated = await read(identity!.conversationRef);
    expect(updated).toMatchObject({ label, firstSeenAt: 100, lastSeenAt: 200 });
    expect(updated?.nativeDirectUserId).toBeUndefined();
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

  it("round-trips authoritative route context on its conversation association", async () => {
    const scope = await seed("ops", "discord");
    const routeContext = {
      peerId: "canonical-ops",
      guildId: "guild-a",
      parentPeerId: "parent-a",
      memberRoleIds: ["support", "admin"],
    };
    await commitInitialization(scope, { routeContext });
    const canonicalConversation = (await listConversations(scope)).find(
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

    await commitInitialization(scope, {
      entry: { updatedAt: canonicalConversation!.lastSeenAt + 100 },
    });
    const resumed = await readConversation(scope, conversationRef);
    expect(resumed!.lastSeenAt).toBeGreaterThan(canonicalConversation!.lastSeenAt);
    expect(resumed).toEqual({ ...canonicalConversation, lastSeenAt: resumed!.lastSeenAt });

    await upsertCanonicalSessionEntry(scope, {
      totalTokens: 42,
      updatedAt: resumed!.lastSeenAt + 100,
    });
    expect(await readConversation(scope, conversationRef)).toEqual(resumed);
    expect(await primary(scope, "ops-session")).toEqual(resumed);

    await commitInitialization(scope, {
      routeContext: { peerId: "canonical-ops", guildId: "guild-b" },
    });
    const observed = await readConversation(scope, conversationRef);
    expect(observed).toMatchObject({ routeContext: { guildId: "guild-b" } });
    expect(observed!.lastSeenAt).toBeGreaterThan(resumed!.lastSeenAt);

    await upsertCanonicalSessionEntry(scope, { label: "generic current write", updatedAt: 200 });
    expect(
      (await listConversations(scope)).filter((conversation) => conversation.role === "primary"),
    ).toEqual([expect.objectContaining({ conversationRef, peerId: "canonical-ops" })]);
    const afterCurrentWrite = await read(conversationRef);
    expect(afterCurrentWrite).toMatchObject({
      label: "generic current write",
      routeContextObserved: true,
      routeContext: { guildId: "guild-b" },
    });

    const database = await reopenDatabase(scope);
    const updatedAssociation = database.db
      .prepare(
        `UPDATE session_conversations SET last_seen_at = ?
         WHERE session_id = ? AND conversation_id = ? AND role = 'primary'`,
      )
      .run(afterCurrentWrite!.lastSeenAt, "ops-session", conversationRef);
    expect(Number(updatedAssociation.changes)).toBe(1);
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
    await upsertCanonicalSessionEntry(scope, {
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
    await writeRoute("channel:alpha", "guild-alpha", 300);
    await writeRoute("channel:beta", "guild-beta", 400);

    expect(
      (await listConversations(scope, { channel: "discord" }))
        .map(({ target, routeContext }) => ({ target, routeContext }))
        .toSorted((left, right) => left.target.localeCompare(right.target)),
    ).toEqual([
      { target: "channel:alpha", routeContext: { guildId: "guild-alpha" } },
      { target: "channel:beta", routeContext: { guildId: "guild-beta" } },
    ]);
    const database = await reopenDatabase(scope);
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
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
    expect((await listConversations(scope))[0]).toMatchObject({
      sessionId: "after-rollover",
      routeContextObserved: true,
      routeContext,
    });
    expect(await primary(scope, "before-rollover")).toBeUndefined();
    expect(await primary(scope, "after-rollover")).toMatchObject({
      routeContext: { guildId: "guild-a" },
    });

    await commitInitialization(scope, { routeContext: null });
    const cleared = (await listConversations(scope))[0];
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
    const database = await reopenDatabase(scope);
    executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_nodes")
        .set(invalid)
        .where("session_key", "=", scope.sessionKey),
    );
    expect(await primary(scope, "peer-a-session")).toBeUndefined();
    if (invalid.entry_json !== undefined) {
      const [conversation] = await listConversations(scope);
      expect(conversation).toMatchObject({ target: "reef:peer-a" });
      expect([conversation?.sessionId, conversation?.sessionKey]).toEqual([undefined, undefined]);
    }
  });

  it("orders fresh directory addresses with session-backed conversation activity", async () => {
    await seed();
    const freshIdentity = address("reef:peer-b");
    const freshAt = Date.now() + 1_000;
    await registerConversationAddresses(registryScope(), [freshIdentity!], freshAt);

    expect(await listConversations(registryScope(), { channel: "reef", limit: 1 })).toEqual([
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

    expect(
      (await listConversations(registryScope(), { channel: "reef", limit: 1 }))[0],
    ).toMatchObject({
      target: "reef:peer-a",
      sessionId: "live-session",
      sessionKey: liveSessionKey,
      lastSeenAt: 100,
    });
  });

  it("retains a deleted session's address without exposing a stale binding", async () => {
    const scope = await seed("peer-a", "reef", "deleted-session");
    const [linked] = await listConversations(registryScope(), { channel: "reef" });
    expect(linked?.sessionId).toBe("deleted-session");

    await deleteSessionEntryLifecycle({
      ...registryScope(),
      target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
      archiveTranscript: false,
    });
    expect(await primary(scope, "deleted-session")).toBeUndefined();

    expect(await read(linked?.conversationRef ?? "missing")).toMatchObject({
      conversationRef: linked?.conversationRef,
      target: "reef:peer-a",
    });
    expect(await read(linked?.conversationRef ?? "missing")).not.toMatchObject({
      sessionId: expect.any(String),
      sessionKey: expect.any(String),
    });
  });

  it("publishes native association role removals atomically and drops rolled-back catalogue changes", async () => {
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
    const installed = new Map<string, unknown>();
    observe(
      conversationPublication.subscribeFacts((receipt) => {
        if ("facts" in receipt) {
          for (const [key, fact] of receipt.facts) {
            installed.set(key, fact);
          }
        }
      }),
    );
    const database = openOpenClawAgentDatabase(options);
    const associationReads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["route"],
      (sql) =>
        sql.startsWith('select "last_seen_at", "route_context_json" from "session_conversations"')
          ? "route"
          : null,
    );
    try {
      write(1, 20, { guildId: "receipt-guild" });
      expect(associationReads.counts.route).toBe(0);
    } finally {
      associationReads.restore();
    }
    expect(await readConversation(scope, identities[1]!.conversationRef)).toMatchObject({
      routeContext: { guildId: "receipt-guild" },
    });
    const associationKey = (index: number, role: string) =>
      JSON.stringify(["association", sessionId, identities[index]!.conversationRef, role]);
    const oldPrimary = associationKey(0, "primary");
    const oldRelated = associationKey(0, "related");
    const newPrimary = associationKey(1, "primary");
    expect(installed.get(oldPrimary)).toEqual({ kind: "absent" });
    for (const [key, role] of [
      [oldRelated, "related"],
      [newPrimary, "primary"],
    ] as const) {
      expectPostimage(installed.get(key), { role, last_seen_at: 20 });
    }
    const committedFacts = new Map(installed);
    expect(() =>
      runOpenClawAgentWriteTransaction(() => {
        write(0, 30);
        throw new Error("rollback conversation");
      }, options),
    ).toThrow("rollback conversation");
    expect(installed).toEqual(committedFacts);
    expect(
      openOpenClawAgentDatabase(options)
        .db.prepare(
          "SELECT role FROM session_conversations WHERE session_id = ? AND conversation_id = ?",
        )
        .get(sessionId, identities[1]!.conversationRef),
    ).toEqual({ role: "primary" });
  });

  it("publishes binding facts without transporting large catalogue metadata", async () => {
    const scope = registryScope();
    const identity = address("large-catalogue", undefined, { channel: "fixture" })!;
    // The request fits IPC; JSON's six-byte escape expands the stored postimage beyond it.
    identity.metadata = {
      payload: "\0".repeat(Math.floor(SQLITE_WORKER_MAX_MESSAGE_BYTES / 6) + 1),
    };
    const events: string[] = [];
    const receipts: ConversationPublication[] = [];
    observe(
      conversationPublication.subscribeFacts((change) => {
        if ("facts" in change) {
          receipts.push(change);
          events.push("facts");
        }
      }),
    );
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
    expect(receipts[0]?.facts.get(JSON.stringify(["catalogue", identity.conversationRef]))).toEqual(
      {
        kind: "postimage",
        value: {
          kind: "catalogue",
          row: { conversation_id: identity.conversationRef, kind: identity.kind },
        },
      },
    );
  });
});
