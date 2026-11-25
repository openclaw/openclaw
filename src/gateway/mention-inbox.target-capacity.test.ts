import { expect, it, vi } from "vitest";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { MENTION_RETENTION_MS, type MentionStoreSource } from "./mention-inbox-store.js";
import { commitMentionChanges, readMentionSnapshot } from "./mention-inbox-worker.js";
import {
  SESSION_ID,
  SESSION_KEY,
  readMentionInbox,
  withMentionInbox,
} from "./mention-inbox.test-support.js";

// Exercise the existing retention boundary with a small real store, not 10,000 worker reads.
vi.mock("./mention-inbox-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mention-inbox-store.js")>()),
  MAX_MENTION_SOURCES: 3,
}));

it("keeps every retained mention visible when query-only target aliases fill the cache", async () => {
  await withMentionInbox(async (f) => {
    const sessionKeys = ["first", "second", "third"].map(
      (suffix) => `agent:main:dashboard:mention-capacity-${suffix}`,
    );
    for (const sessionKey of sessionKeys) {
      await f.setSession({}, sessionKey);
    }
    expect((await readMentionInbox(f.inbox, f.bobClient)).items).toEqual([]);
    expect(
      await f.call("users.mentionable", { sessionKey: SESSION_KEY }, f.aliceClient),
    ).toMatchObject({ ok: true });

    const createdAt = f.scheduler.now();
    const sources = new Map<string, MentionStoreSource>(
      sessionKeys.map((sessionKey, sequence) => {
        const key = String(sequence + 1).repeat(64);
        return [
          key,
          {
            key,
            sequence,
            expiresAt: createdAt + MENTION_RETENTION_MS,
            recipients: [[f.bob.id, `capacity-item-${sequence}`]],
            message: {
              sessionId: SESSION_ID,
              content: {
                senderProfileId: f.alice.id,
                sessionKey,
                agentId: "main",
                messageId: `capacity-message-${sequence}`,
                createdAt,
              },
            },
          },
        ];
      }),
    );
    const context = captureOpenClawStateWorkerContext();
    const snapshot = await readMentionSnapshot(context, -1);
    if (!snapshot) {
      throw new Error("Expected the mention fixture snapshot");
    }
    expect(
      await commitMentionChanges(
        context,
        { expectedHead: snapshot.head, nextSequence: sources.size, changes: [...sources] },
        () => context.admission.assertCurrent(),
      ),
    ).toMatchObject({ kind: "committed" });

    expect(
      (await readMentionInbox(f.inbox, f.bobClient)).items.map((item) => item.sessionKey),
    ).toEqual(sessionKeys.toReversed());
  });
});
