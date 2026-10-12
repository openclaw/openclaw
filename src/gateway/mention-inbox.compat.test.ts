import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import * as mentionWorker from "./mention-inbox-worker.js";
import {
  SESSION_KEY,
  SESSION_ID,
  withMentionInbox as withInbox,
  readMentionInbox as read,
} from "./mention-inbox.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("released Mention Inbox compatibility", () => {
  it("publishes a foreign dismissal before a released invalidation returns", async () => {
    await withInbox(async (f) => {
      await f.post("before-invalidation");
      const previous = f.inbox.list(f.bobClient);
      if (!previous.ok) {
        throw new Error(previous.error.message);
      }
      const peer = f.openInbox("foreign-invalidation");
      expect(peer.dismiss(f.bobClient, [previous.value.items[0]!.id])).toMatchObject({
        ok: true,
        value: { items: [] },
      });
      f.broadcast.mockClear();
      const returned = f.inbox.invalidate();
      expect(f.broadcast).toHaveBeenCalledWith(
        "mentions.changed",
        { gatewayInstanceId: "mention-gateway", revision: previous.value.revision + 1 },
        new Set([f.bobClient.connId]),
      );
      expect(returned).toBeUndefined();
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
            expect(f.inbox.list(f.bobClient)).toMatchObject({
              ok: true,
              value: { items: [] },
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
        }
        expect((await read(f.inbox, f.bobSecond)).items).toHaveLength(commit ? 1 : 0);
      }
    });
  });

  it("publishes nested native dismissals only after commit and discards rollback notifications", async () => {
    await withInbox(async (f) => {
      await f.post("nested");
      const item = (await read(f.inbox, f.bobClient)).items[0]!;
      const rollback = new Error("synthetic outer rollback");
      for (const commit of [false, true]) {
        f.broadcast.mockClear();
        const transaction = () =>
          runOpenClawStateWriteTransaction(() => {
            expect(f.inbox.dismiss(f.bobClient, [item.id])).toMatchObject({
              ok: true,
              value: { items: [] },
            });
            expect(f.broadcast).not.toHaveBeenCalled();
            if (commit) {
              expect(() =>
                runOpenClawStateWriteTransaction(() => {
                  f.inbox.list(f.bobClient);
                  throw rollback;
                }),
              ).toThrow(rollback);
              expect(f.broadcast).not.toHaveBeenCalled();
            }
            if (!commit) {
              throw rollback;
            }
          });
        if (commit) {
          transaction();
          expect(
            f.broadcast.mock.calls.some(
              ([event, , recipients]) =>
                event === "mentions.changed" && recipients.has(f.bobSecond.connId),
            ),
          ).toBe(true);
        } else {
          expect(transaction).toThrow(rollback);
          expect(f.broadcast).not.toHaveBeenCalled();
        }
        expect((await read(f.inbox, f.bobSecond)).items).toEqual(commit ? [] : [item]);
      }
    });
  });

  it("keeps a newer native dismissal when an earlier worker commit reply arrives", async () => {
    await withInbox(async (f) => {
      await f.post("original");
      const original = (await read(f.inbox, f.bobClient)).items;
      f.push.mockClear();
      const commitChanges = mentionWorker.commitMentionChanges;
      const committed = createDeferred();
      const release = createDeferred();
      const spy = vi
        .spyOn(mentionWorker, "commitMentionChanges")
        .mockImplementationOnce(async (...args) => {
          const result = await commitChanges(...args);
          committed.resolve();
          await release.promise;
          return result;
        });
      const pending = f.post("late-receipt");
      try {
        await awaitGateBeforeSettlement(
          committed.promise,
          pending,
          "Worker mutation did not commit",
        );
        const durable = f.inbox.list(f.bobClient);
        if (!durable.ok) {
          throw new Error(durable.error.message);
        }
        const late = durable.value.items.find((item) => item.messageId === "message-late-receipt");
        if (!late) {
          throw new Error("Native reader did not see the committed worker input");
        }
        expect(f.inbox.dismiss(f.bobClient, [late.id])).toMatchObject({
          ok: true,
          value: { items: original },
        });
        release.resolve();
        await pending;
        expect(f.inbox.list(f.bobClient)).toMatchObject({ ok: true, value: { items: original } });
        expect((await read(f.inbox, f.bobClient)).items).toEqual(original);
        expect(f.push).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
        spy.mockRestore();
      }
    });
  });
});
