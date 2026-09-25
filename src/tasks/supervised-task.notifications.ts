import { randomUUID } from "node:crypto";
import { getRuntimeConfig } from "../config/config.js";
import { getConversationDeliveryOperation } from "../config/sessions/conversation-delivery-store.js";
import {
  resolveConversationRegistryScope,
  resolveCurrentSessionPrimaryConversation,
} from "../config/sessions/conversation-registry.js";
import { resolveConversationRouteFingerprint } from "../config/sessions/conversation-route-fingerprint.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { runGatewayConversationSend } from "../gateway/conversation-send.js";
import { loadGatewaySessionEntryReadOnly } from "../gateway/session-utils.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { getSupervisedTaskSource } from "./supervised-task.source.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

/** Notification obligation is independent of task success and shared-queue delivery. */
export function startSupervisedTaskNotifications(params: {
  options?: Options;
  onError: (error: unknown) => void;
}) {
  const options = params.options ?? {};
  const owner = randomUUID();
  let stopped = false;
  let busy = false;
  const shutdown = new AbortController();
  const tick = async () => {
    if (stopped || busy) {
      return;
    }
    busy = true;
    try {
      const rows =
        readSupervisedWorkflow(
          (db) =>
            tableExists(db, "task_flow_notifications")
              ? executeSqliteQuerySync(
                  db,
                  getNodeSqliteKysely<DB>(db)
                    .selectFrom("task_flow_notifications")
                    .selectAll()
                    .where("state", "in", ["pending", "queued"])
                    .where("due_at_ms", "<=", Date.now())
                    .orderBy("due_at_ms")
                    .limit(16),
                ).rows
              : [],
          options,
        ) ?? [];
      for (const row of rows) {
        if (stopped) {
          break;
        }
        const claimed = writeSupervisedWorkflow(
          (db) =>
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<DB>(db)
                .updateTable("task_flow_notifications")
                .set({ owner_id: owner, lease_expires_at_ms: Date.now() + 120_000 })
                .where("notification_id", "=", row.notification_id)
                .where("state", "in", ["pending", "queued"])
                .where((eb) =>
                  eb.or([
                    eb("lease_expires_at_ms", "is", null),
                    eb("lease_expires_at_ms", "<=", Date.now()),
                  ]),
                ),
            ).numAffectedRows === 1n,
          options,
        );
        if (!claimed) {
          continue;
        }
        const settle = (
          state: "queued" | "delivered" | "suppressed" | "failed" | "unknown",
          receipt: Record<string, string> = {},
        ) => {
          writeSupervisedWorkflow(
            (db) =>
              executeSqliteQuerySync(
                db,
                getNodeSqliteKysely<DB>(db)
                  .updateTable("task_flow_notifications")
                  .set({
                    state,
                    receipt_json: JSON.stringify(receipt),
                    updated_at_ms: Date.now(),
                    due_at_ms: Date.now() + 5000,
                    owner_id: null,
                    lease_expires_at_ms: null,
                  })
                  .where("notification_id", "=", row.notification_id)
                  .where("owner_id", "=", owner),
              ),
            options,
          );
        };
        const assertClaimCurrent = () => {
          shutdown.signal.throwIfAborted();
          const lease = readSupervisedWorkflow(
            (db) =>
              executeSqliteQueryTakeFirstSync(
                db,
                getNodeSqliteKysely<DB>(db)
                  .selectFrom("task_flow_notifications")
                  .select(["owner_id", "lease_expires_at_ms", "state"])
                  .where("notification_id", "=", row.notification_id),
              ),
            options,
          );
          if (
            !lease ||
            lease.owner_id !== owner ||
            lease.lease_expires_at_ms === null ||
            lease.lease_expires_at_ms <= Date.now() ||
            !["pending", "queued"].includes(lease.state)
          ) {
            throw new Error("Task notification owner no longer has delivery authority");
          }
        };
        const heartbeat = setInterval(() => {
          if (stopped) {
            return;
          }
          try {
            writeSupervisedWorkflow(
              (db) =>
                executeSqliteQuerySync(
                  db,
                  getNodeSqliteKysely<DB>(db)
                    .updateTable("task_flow_notifications")
                    .set({ lease_expires_at_ms: Date.now() + 120_000 })
                    .where("notification_id", "=", row.notification_id)
                    .where("owner_id", "=", owner)
                    .where("lease_expires_at_ms", ">", Date.now())
                    .where("state", "in", ["pending", "queued"]),
                ),
              options,
            );
          } catch (error) {
            try {
              params.onError(error);
            } catch {
              /* Observer only. */
            }
          }
        }, 30_000);
        heartbeat.unref();
        try {
          const source = getSupervisedTaskSource(row.flow_id, options);
          if (!source) {
            settle("failed", { reason: "Task source binding unavailable" });
            continue;
          }
          const assertSourceCurrent = () => {
            assertClaimCurrent();
            const current = loadGatewaySessionEntryReadOnly(source.sessionKey, {
              agentId: source.agentId,
            });
            if (
              current.entry?.sessionId !== source.sessionId ||
              current.entry.archivedAt !== undefined
            ) {
              throw new Error("Task source session changed before notification delivery");
            }
            if (source.conversationRef) {
              const conversation = resolveCurrentSessionPrimaryConversation({
                ...source,
                ...resolveConversationRegistryScope({
                  config: getRuntimeConfig(),
                  agentId: source.agentId,
                }),
              });
              if (
                !conversation ||
                conversation.conversationRef !== source.conversationRef ||
                resolveConversationRouteFingerprint(conversation) !== source.routeFingerprint
              ) {
                throw new Error("Task notification route changed");
              }
            }
          };
          const existing = source.conversationRef
            ? getConversationDeliveryOperation(
                resolveConversationRegistryScope({
                  config: getRuntimeConfig(),
                  agentId: source.agentId,
                }),
                row.notification_id,
              )
            : undefined;
          if (
            existing &&
            ["sent", "replied", "suppressed", "rejected", "unknown"].includes(existing.status)
          ) {
            settle(
              existing.status === "sent" || existing.status === "replied"
                ? "delivered"
                : existing.status === "rejected"
                  ? "failed"
                  : existing.status === "suppressed"
                    ? "suppressed"
                    : "unknown",
              {
                operationId: existing.operationId,
                ...(existing.platformMessageId ? { messageId: existing.platformMessageId } : {}),
              },
            );
            continue;
          }
          assertSourceCurrent();
          const appended = await appendAssistantMessageToSessionTranscript({
            agentId: source.agentId,
            sessionKey: source.sessionKey,
            expectedSessionId: source.sessionId,
            text: row.content,
            idempotencyKey: row.notification_id,
            updateMode: "file-only",
            config: getRuntimeConfig(),
          });
          if (!appended.ok) {
            throw new Error("Task notification history append unavailable");
          }
          assertSourceCurrent();
          if (!source.conversationRef) {
            settle("delivered", { delivery: "source-session-history" });
            continue;
          }
          if (existing?.status === "queued") {
            settle(Date.now() - row.created_at_ms > 24 * 3_600_000 ? "unknown" : "queued", {
              queueId: existing.queueId ?? "",
              operationId: existing.operationId,
            });
            continue;
          }
          const result = await runGatewayConversationSend({
            config: getRuntimeConfig(),
            readCurrentConfig: getRuntimeConfig,
            agentId: source.agentId,
            senderIsOwner: false,
            sourceSessionKey: source.sessionKey,
            operationId: row.notification_id,
            conversationRef: source.conversationRef,
            message: row.content,
            assertSourceCurrent,
            signal: shutdown.signal,
          });
          settle(
            result.status === "sent"
              ? "delivered"
              : result.status === "suppressed"
                ? "suppressed"
                : result.status === "unknown"
                  ? "unknown"
                  : "queued",
            {
              ...(result.messageId ? { messageId: result.messageId } : {}),
              ...(result.queueId ? { queueId: result.queueId } : {}),
            },
          );
        } catch (error) {
          try {
            params.onError(error);
          } catch {
            /* Diagnostics cannot change custody. */
          }
          writeSupervisedWorkflow((db) => {
            const current = executeSqliteQueryTakeFirstSync(
              db,
              getNodeSqliteKysely<DB>(db)
                .selectFrom("task_flow_notifications")
                .select("attempts")
                .where("notification_id", "=", row.notification_id)
                .where("owner_id", "=", owner),
            );
            if (!current) {
              return;
            }
            const attempts = current.attempts + 1;
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<DB>(db)
                .updateTable("task_flow_notifications")
                .set({
                  attempts,
                  state: attempts >= 8 ? "failed" : row.state,
                  owner_id: null,
                  lease_expires_at_ms: null,
                  due_at_ms: Date.now() + Math.min(3_600_000, 1000 * 2 ** attempts),
                  updated_at_ms: Date.now(),
                  receipt_json: JSON.stringify({
                    reason: "Notification delivery unavailable; task endpoint is unchanged",
                  }),
                })
                .where("notification_id", "=", row.notification_id)
                .where("owner_id", "=", owner),
            );
          }, options);
        } finally {
          clearInterval(heartbeat);
        }
      }
    } catch (error) {
      try {
        params.onError(error);
      } catch {
        /* Observer only. */
      }
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  void tick();
  return {
    tick,
    stop: () => {
      stopped = true;
      shutdown.abort(new Error("Task notification service stopped"));
      clearInterval(timer);
    },
  };
}
