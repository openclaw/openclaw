import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MAX_HUMAN_MENTIONS } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as policyReads from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { MentionStoreSource } from "./mention-inbox-store.codec.js";
import {
  readMentionStoreSnapshotInDatabase,
  writeMentionStoreChanges,
} from "./mention-inbox-store.js";
import {
  dismissMentionInbox,
  readMentionInbox,
  SESSION_ID,
  SESSION_KEY,
  withMentionInbox,
} from "./mention-inbox.test-support.js";

it("lists and dismisses after restart with more retained recipients than one policy read", async () => {
  await withMentionInbox(async (f) => {
    const { inbox, bob, bobClient, openInbox } = f;
    await f.post("live");
    expect((await readMentionInbox(inbox, bobClient)).items).toHaveLength(1);
    await inbox.dispose();

    // Valid consumed sources outlive their historical profiles. Seed through the
    // canonical writer; only the single live mention needs real delivery setup.
    runOpenClawStateWriteTransaction(({ db }) => {
      const snapshot = readMentionStoreSnapshotInDatabase(-1, db)!;
      const live = snapshot.sources[0]!;
      const changes = new Map<string, MentionStoreSource>();
      let nextSequence = snapshot.head.nextSequence;
      for (let source = 0; source < 1_001; source++) {
        const sourceId = "capacity-consumed-" + source;
        const key = createHash("sha256")
          .update(JSON.stringify(["main", SESSION_KEY, SESSION_ID, sourceId]))
          .digest("hex");
        changes.set(key, {
          key,
          sequence: nextSequence++,
          expiresAt: live.expiresAt,
          recipients: Array.from({ length: MAX_HUMAN_MENTIONS }, (_, recipient) => [
            source === 0 && recipient === 0 ? bob.id : "historical-" + source + "-" + recipient,
            null,
          ]),
        });
      }
      writeMentionStoreChanges(db, { ...snapshot.head, nextSequence }, changes);
    });

    const restarted = openInbox("capacity-restart");
    const listed = await readMentionInbox(restarted, bobClient);
    expect(listed.items.map((item) => item.messageId)).toEqual(["message-live"]);
    const dismissed = await dismissMentionInbox(restarted, bobClient, [listed.items[0]!.id]);
    expect(dismissed).toMatchObject({ ok: true, value: { items: [] } });
    await restarted.dispose();

    const reopened = openInbox("capacity-reopened");
    expect((await readMentionInbox(reopened, bobClient)).items).toEqual([]);
    await f.post("capacity-consumed-0", {}, reopened);
    expect((await readMentionInbox(reopened, bobClient)).items).toEqual([]);
  });
});

it("serializes directory, recipient validation and delivery without crossing publication authority", async () => {
  await withMentionInbox(async (f) => {
    await readMentionInbox(f.inbox, f.bobClient);
    f.clients.length = 0;
    // The operation's requester stays prepared even without a connected client
    // or retained mention keeping that profile in the cache through dismissal.
    expect(await dismissMentionInbox(f.inbox, f.bobClient, [])).toMatchObject({
      ok: true,
      value: { items: [] },
    });
    const held = createDeferred();
    const release = createDeferred();
    const read = policyReads.executeExistingOpenClawStateRead;
    let profileReads = 0;
    const spy = vi
      .spyOn(policyReads, "executeExistingOpenClawStateRead")
      .mockImplementation(async (...args) => {
        if (args[1].type !== "mentions.policy") {
          return read(...args);
        }
        profileReads++;
        const result = await read(...args);
        if (args[1].input.directory) {
          held.resolve();
          await release.promise;
        }
        return result;
      });
    const order: string[] = [];
    const pending: Promise<unknown>[] = [];
    try {
      const directory = f.inbox.mentionable(
        f.aliceClient,
        { sessionKey: SESSION_KEY },
        (result) => {
          order.push("directory");
          expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
          return undefined;
        },
      );
      pending.push(directory);
      await held.promise;
      f.aliceClient.invalidated = true;
      const validation = f.inbox
        .validateRecipients(f.bobClient, { sessionKey: SESSION_KEY }, [
          "missing-operation-recipient",
        ])
        .then((result) => {
          order.push("validation");
          expect(result).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
        });
      pending.push(validation);
      pending.push(
        f.post("queued-live").then(() => {
          order.push("delivery");
        }),
      );
      pending.push(
        readMentionInbox(f.inbox, f.bobClient).then((result) => {
          order.push("list");
          expect(result.items.map((item) => item.messageId)).toEqual(["message-queued-live"]);
        }),
      );
      // Validation used to start another worker read immediately, while the
      // directory owned prepared facts. It now waits behind the same FIFO boundary.
      expect(profileReads).toBe(1);
      expect(order).toEqual([]);
      release.resolve();
      await Promise.all(pending);
      expect(order).toEqual(["directory", "validation", "delivery", "list"]);
    } finally {
      release.resolve();
      await Promise.allSettled(pending);
      spy.mockRestore();
    }
  });
});
