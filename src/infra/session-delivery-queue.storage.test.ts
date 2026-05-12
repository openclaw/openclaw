import { describe, expect, it } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  ackSessionDelivery,
  enqueueSessionDelivery,
  failSessionDelivery,
  loadPendingSessionDelivery,
  loadPendingSessionDeliveries,
} from "./session-delivery-queue.js";

type SessionDeliveryQueueTestDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;

describe("session-delivery queue storage", () => {
  it("dedupes entries when an idempotency key is reused", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const firstId = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue after restart",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          idempotencyKey: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        tempDir,
      );
      const secondId = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue after restart",
          messageId: "restart-sentinel:agent:main:main:agentTurn:123",
          idempotencyKey: "restart-sentinel:agent:main:main:agentTurn:123",
        },
        tempDir,
      );

      expect(secondId).toBe(firstId);
      expect(await loadPendingSessionDeliveries(tempDir)).toHaveLength(1);
    });
  });

  it("persists retry metadata and removes acked entries", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:main",
          text: "restart complete",
        },
        tempDir,
      );

      await failSessionDelivery(id, "dispatch failed", tempDir);
      const [failedEntry] = await loadPendingSessionDeliveries(tempDir);
      expect(failedEntry?.retryCount).toBe(1);
      expect(failedEntry?.lastError).toBe("dispatch failed");

      await ackSessionDelivery(id, tempDir);
      expect(await loadPendingSessionDeliveries(tempDir)).toStrictEqual([]);
    });
  });

  it("stores queryable routing and retry fields beside the replay payload", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue after restart",
          messageId: "message-1",
          route: {
            accountId: "acct-1",
            channel: "discord",
            chatType: "direct",
            to: "user-1",
          },
        },
        tempDir,
      );

      await failSessionDelivery(id, "dispatch failed", tempDir);

      const database = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      const db = getNodeSqliteKysely<SessionDeliveryQueueTestDatabase>(database.db);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("delivery_queue_entries")
          .select([
            "account_id",
            "channel",
            "entry_kind",
            "last_error",
            "retry_count",
            "session_key",
            "target",
          ])
          .where("queue_name", "=", "session-delivery")
          .where("id", "=", id),
      );
      expect(row).toMatchObject({
        account_id: "acct-1",
        channel: "discord",
        entry_kind: "agentTurn",
        last_error: "dispatch failed",
        retry_count: 1,
        session_key: "agent:main:main",
        target: "user-1",
      });
    });
  });

  it("loads routing and retry state from typed columns instead of replay JSON", async () => {
    await withTempDir({ prefix: "openclaw-session-delivery-" }, async (tempDir) => {
      const id = await enqueueSessionDelivery(
        {
          kind: "agentTurn",
          sessionKey: "agent:main:main",
          message: "continue after restart",
          messageId: "message-1",
          route: {
            accountId: "acct-typed",
            channel: "discord",
            chatType: "direct",
            to: "user-typed",
          },
        },
        tempDir,
      );
      await failSessionDelivery(id, "typed dispatch failed", tempDir);

      const database = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: tempDir },
      });
      const db = getNodeSqliteKysely<SessionDeliveryQueueTestDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("delivery_queue_entries")
          .set({
            entry_json: JSON.stringify({
              id,
              enqueuedAt: 1,
              kind: "agentTurn",
              lastAttemptAt: 1,
              lastError: "json dispatch failed",
              message: "continue after restart",
              messageId: "message-1",
              retryCount: 99,
              route: {
                accountId: "acct-json",
                channel: "slack",
                chatType: "direct",
                to: "user-json",
              },
              sessionKey: "agent:json:main",
            }),
            updated_at: Date.now(),
          })
          .where("queue_name", "=", "session-delivery")
          .where("id", "=", id),
      );

      const entry = await loadPendingSessionDelivery(id, tempDir);

      expect(entry).toMatchObject({
        kind: "agentTurn",
        lastError: "typed dispatch failed",
        retryCount: 1,
        route: {
          accountId: "acct-typed",
          channel: "discord",
          to: "user-typed",
        },
        sessionKey: "agent:main:main",
      });
      expect(typeof entry?.lastAttemptAt).toBe("number");
    });
  });
});
