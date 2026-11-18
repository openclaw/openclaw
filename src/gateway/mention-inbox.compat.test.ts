import { describe, expect, it } from "vitest";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  withMentionInbox as withInbox,
  readMentionInbox as read,
  SESSION_KEY,
  SESSION_ID,
} from "./mention-inbox.test-support.js";

describe("deprecated Mention Inbox signatures", () => {
  it("rejects synchronous persistence with migration guidance and preserves awaited state", async () => {
    await withInbox(async (f) => {
      await f.post("awaited");
      const before = await read(f.inbox, f.bobClient);
      const item = before.items[0]!;
      expect(f.inbox.list(f.bobClient)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringContaining("listAsync") },
      });
      expect(f.inbox.dismiss(f.bobClient, [item.id])).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: expect.stringContaining("dismissAsync") },
      });
      expect(() => f.inbox.invalidate()).toThrow("invalidateAsync");
      expect((await read(f.inbox, f.bobClient)).items).toEqual(before.items);
      await f.inbox.dismissAsync(f.bobClient, [item.id], (result) => {
        expect(result).toMatchObject({ ok: true, value: { items: [] } });
      });
      expect((await read(f.openInbox("reopened"), f.bobClient)).items).toEqual([]);
    });
  });

  it("queues legacy records after outer commit and discards rolled-back submissions", async () => {
    await withInbox(async (f) => {
      const rollback = new Error("synthetic record rollback");
      for (const commit of [false, true]) {
        f.broadcast.mockClear();
        f.push.mockClear();
        const transaction = () =>
          runOpenClawStateWriteTransaction(() => {
            f.inbox.recordCommittedInput({
              sourceId: "nested-record",
              committedSource: {
                generation: "test-generation",
                sequence: 1,
                timestamp: f.scheduler.now(),
              },
              sessionKey: SESSION_KEY,
              agentId: "main",
              sessionId: SESSION_ID,
              messageId: "message-nested-record",
              senderProfileId: f.alice.id,
              recipientProfileIds: [f.bob.id],
            });
            expect(f.broadcast).not.toHaveBeenCalled();
            expect(f.push).not.toHaveBeenCalled();
            if (!commit) {
              throw rollback;
            }
          });
        if (commit) {
          transaction();
          expect((await read(f.inbox, f.bobClient)).items).toEqual([
            expect.objectContaining({ messageId: "message-nested-record" }),
          ]);
          expect(f.push).toHaveBeenCalledOnce();
          expect(f.broadcast).toHaveBeenCalledWith(
            "mentions.changed",
            expect.objectContaining({ gatewayInstanceId: "mention-gateway" }),
            new Set([f.bobSecond.connId]),
          );
        } else {
          expect(transaction).toThrow(rollback);
          expect(f.broadcast).not.toHaveBeenCalled();
          expect(f.push).not.toHaveBeenCalled();
          expect((await read(f.inbox, f.bobClient)).items).toEqual([]);
        }
        expect((await read(f.inbox, f.bobSecond)).items).toHaveLength(commit ? 1 : 0);
      }
    });
  });
});
