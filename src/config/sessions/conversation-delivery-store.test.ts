import path from "node:path";
import { afterAll, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  beginConversationDeliveryOperation,
  ConversationDeliveryInputError,
  findConversationTurnDeliveryByReplyTarget,
  getConversationDeliveryOperation,
  markConversationDeliveryQueued,
  markConversationDeliveryRejected,
  markConversationDeliveryReplied,
  markConversationDeliverySent,
  markConversationDeliveryUnknown,
} from "./conversation-delivery-store.js";
import {
  conversationEntry,
  conversationRef as reefConversationRef,
} from "./conversation-delivery-store.test-support.js";
import type { ConversationDeliveryBegin } from "./conversation-delivery-store.types.js";
import { readConversation } from "./conversation-registry.js";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { historyLane } from "./session-transcript-worker-resources.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-conversation-delivery-");
const sessionKey = "agent:main:reef:direct:peer-agent";

async function conversationStore() {
  const conversationRef = reefConversationRef;
  const scope = { agentId: "main", storePath: path.join(sessionDirs.make(), "sessions.json") };
  await upsertSessionEntryCore({ ...scope, sessionKey }, conversationEntry("reef-session", 100));
  return {
    scope,
    conversationRef,
    get: getConversationDeliveryOperation.bind(null, scope),
    queue: markConversationDeliveryQueued.bind(null, scope),
    send: markConversationDeliverySent.bind(null, scope),
    begin: (
      operationId: string,
      input: Partial<ConversationDeliveryBegin> = {},
      guard?: () => void,
    ) =>
      beginConversationDeliveryOperation(
        scope,
        { operationId, operationKind: "send", conversationRef, message: "hello", ...input },
        guard,
      ),
  };
}

it("preserves input conflicts without waiting for reader retirement that needs the next writer", async () => {
  const { scope, conversationRef, begin, get } = await conversationStore();
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  openOpenClawAgentDatabase(options);
  const input = { operationKind: "send" as const, conversationRef, message: "original" };
  await begin("conflict", input);
  const historyRetiring = createDeferred();
  const writerSettled = createDeferred();
  const releaseHistory = createDeferred();
  using _ = vi.spyOn(historyLane.pool, "rotate").mockImplementation(() => {
    historyRetiring.resolve();
    return Promise.race([writerSettled.promise, releaseHistory.promise]);
  });
  const reading = get("conflict", { ...input, message: "changed" });
  const outcome = reading.catch((error: unknown) => error);
  const following = runOpenClawAgentWriteAdmission(options, () => {
    writerSettled.resolve();
    return "following writer";
  });
  try {
    const result = await Promise.race([
      outcome,
      historyRetiring.promise.then(
        () => new Error("Conflict cleanup waits on the writer queued behind its own admission"),
      ),
    ]);
    expect(result).toBeInstanceOf(ConversationDeliveryInputError);
    expect(result).toMatchObject({
      message: expect.stringContaining("reused with different input"),
    });
    await expect(following).resolves.toBe("following writer");
  } finally {
    releaseHistory.resolve();
    await Promise.allSettled([reading, following]);
  }
});

it("persists queue, platform, and correlated reply evidence", async () => {
  const { scope, conversationRef, begin, get, queue, send } = await conversationStore();
  const begun = begin("operation-2", { operationKind: "turn", preparedMessageId: "prepared-2" });
  const queued = queue("operation-2", "queue-2");
  const sent = send("operation-2", "platform-2");
  const read = get("operation-2");
  await begun;
  expect(await queued).toMatchObject({ status: "queued", queueId: "queue-2" });
  expect(await sent).toMatchObject({ status: "sent", platformMessageId: "platform-2" });
  expect(await read).toEqual(await sent);
  const replied = await markConversationDeliveryReplied(scope, {
    operationId: "operation-2",
    reply: { messageId: "reply-2", replyToId: "platform-2", text: "ack", timestamp: 200 },
  });

  expect(replied).toMatchObject({
    status: "replied",
    reply: { messageId: "reply-2", text: "ack" },
  });
  expect(
    await findConversationTurnDeliveryByReplyTarget(scope, {
      conversationRef,
      replyToId: "prepared-2",
    }),
  ).toEqual(replied);
  expect(await get("operation-2")).toEqual(replied);
  // Late queue/sent callbacks cannot regress a completed correlated reply.
  expect(await queue("operation-2", "queue-late")).toEqual(replied);
  expect(await send("operation-2", "platform-late")).toEqual(replied);
});

it.each(["rejected", "unknown"] as const)("makes a %s queued delivery terminal", async (status) => {
  const { scope, begin, queue, send } = await conversationStore();
  await begin("terminal");
  await queue("terminal", "queue");
  const terminal =
    status === "rejected"
      ? await markConversationDeliveryRejected(scope, "terminal", "atomic message limit")
      : await markConversationDeliveryUnknown(scope, "terminal");
  expect(terminal).toMatchObject({
    status,
    queueId: "queue",
    ...(status === "rejected" ? { rejectionError: "atomic message limit" } : {}),
  });
  expect(await send("terminal", "platform-late")).toEqual(terminal);
});

it.each(["maintenance", "guarded deletion"] as const)(
  "retains source-bound delivery evidence during %s",
  async (cleanup) => {
    const { scope, conversationRef, begin, get, send } = await conversationStore();
    await begin("preserved", { sourceSessionKey: sessionKey });
    await send("preserved", "platform-preserved");
    if (cleanup === "maintenance") {
      await applySessionEntryLifecycleMutation({
        ...scope,
        maintenanceOverride: { mode: "enforce", pruneAfterMs: 1 },
      });
      expect(loadSessionEntry({ ...scope, sessionKey })?.archivedAt).toBeUndefined();
    } else {
      await deleteSessionEntryLifecycle({
        ...scope,
        archiveTranscript: false,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      expect(loadSessionEntry({ ...scope, sessionKey })).toBeUndefined();
    }
    const conversation = await readConversation(scope, conversationRef);
    expect(conversation).toMatchObject({ conversationRef, channel: "reef" });
    expect(conversation?.sessionId).toBe(cleanup === "maintenance" ? "reef-session" : undefined);
    expect(await get("preserved")).toMatchObject({
      channel: "reef",
      conversationRef,
      platformMessageId: "platform-preserved",
      sourceSessionKey: sessionKey,
      status: "sent",
    });
  },
);

it("removes only source-bound delivery evidence and its progress cache when fully deleted", async () => {
  const { scope, conversationRef, begin, get, send } = await conversationStore();
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteReadScope(scope)));
  const progressJson = JSON.stringify({ lines: ["Working"] });
  for (const [operationId, sourceSessionKey] of [
    ["deleted", sessionKey],
    ["other", "agent:main:other"],
  ] as const) {
    await begin(operationId, { sourceSessionKey });
    await send(operationId, "platform-deleted");
    database.db
      .prepare(
        "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('conversation-progress', ?, ?, 1)",
      )
      .run(operationId, progressJson);
  }
  database.db
    .prepare("INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
    .run("unrelated", "deleted", "keep", 1);

  await deleteSessionEntryLifecycle({
    ...scope,
    archiveTranscript: false,
    deleteDeliveryArtifacts: true,
    target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
  });

  expect(await get("deleted")).toBeUndefined();
  expect(
    database.db
      .prepare("SELECT key, value_json FROM cache_entries WHERE scope = 'conversation-progress'")
      .all(),
  ).toEqual([{ key: "other", value_json: progressJson }]);
  expect(
    database.db
      .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
      .get("unrelated", "deleted"),
  ).toEqual({ value_json: "keep" });
  expect(await readConversation(scope, conversationRef)).toMatchObject({ conversationRef });
});

it("rejects a reservation whose caller loses authority while queued", async () => {
  const { scope, begin, get } = await conversationStore();
  const entered = createDeferred();
  const release = createDeferred();
  const held = runOpenClawAgentWriteAdmission(
    toDatabaseOptions(resolveSqliteReadScope(scope)),
    () => {
      entered.resolve();
      return release.promise;
    },
  );
  onTestFinished(async () => {
    release.resolve();
    await held;
  });
  await entered.promise;
  let current = true;
  const begun = begin("revoked", {}, () => {
    if (!current) {
      throw new Error("delivery authority revoked");
    }
  });
  const rejected = expect(begun).rejects.toThrow("delivery authority revoked");
  current = false;
  release.resolve();
  await held;
  await rejected;
  expect(await get("revoked")).toBeUndefined();
});
