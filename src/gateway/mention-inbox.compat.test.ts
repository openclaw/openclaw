import { describe, expect, it } from "vitest";
import {
  withMentionInbox as withInbox,
  readMentionInbox as read,
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
      expect(() =>
        f.inbox.recordCommittedInput({
          sourceId: "rejected",
          committedSource: { generation: "test", sequence: 1, timestamp: f.scheduler.now() },
          sessionKey: item.sessionKey,
          agentId: item.agentId,
          sessionId: "rejected",
          messageId: "rejected",
          senderProfileId: f.alice.id,
          recipientProfileIds: [f.bob.id],
        }),
      ).toThrow("recordCommittedInputAsync");
      expect((await read(f.inbox, f.bobClient)).items).toEqual(before.items);
      await f.inbox.dismissAsync(f.bobClient, [item.id], (result) => {
        expect(result).toMatchObject({ ok: true, value: { items: [] } });
      });
      expect((await read(f.openInbox("reopened"), f.bobClient)).items).toEqual([]);
    });
  });
});
