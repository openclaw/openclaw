import {
  inflateDeliveryQueueRow,
  type DeliveryQueueDatabase,
} from "../../../../src/infra/delivery-queue-sqlite-bound.js";
import { resolveDeliveryQueueAttemptCount } from "../../../../src/infra/delivery-queue-sqlite.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../../src/infra/kysely-sync.js";
import { OUTBOUND_EXECUTABLE_QUEUE_NAMES } from "../../../../src/infra/outbound/delivery-queue-namespaces.js";
import { projectOutboundDelivery } from "../../../../src/infra/outbound/delivery-queue-projection.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";

export function deliveryErrorCode(error: string | null | undefined) {
  if (!error) {
    return null;
  }
  if (error.includes("returned no delivery identity")) {
    return "no_delivery_identity";
  }
  if (error.includes("automatic completion delivery could not be confirmed")) {
    return "unconfirmed_completion";
  }
  if (error.includes("refusing blind replay") || error.includes("reconciliation is unresolved")) {
    return "unresolved_send";
  }
  return (
    /\b(?:EACCES|ECONNREFUSED|ECONNRESET|ENOENT|ETIMEDOUT|SQLITE_BUSY)\b/u.exec(error)?.[0] ?? "other"
  );
}

function readQueue(env: NodeJS.ProcessEnv, sessionKeys: string[], ids: string[], since: number) {
  if (!env.OPENCLAW_STATE_DIR) {
    return "unavailable";
  }
  try {
    return withOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DeliveryQueueDatabase>(db)
            .selectFrom("delivery_queue_entries")
            .selectAll()
            .where((eb) =>
              eb.or([
                eb.and([eb("session_key", "in", sessionKeys), eb("enqueued_at", ">=", since)]),
                ...(ids.length > 0 ? [eb("id", "in", ids)] : []),
              ]),
            )
            .orderBy("updated_at", "desc")
            .limit(4),
        )
          .rows.toReversed()
          .map((row) => {
            const entry = inflateDeliveryQueueRow(row);
            const prepared =
              entry &&
              (row.status === "pending" || row.recovery_state === "settlement_pending") &&
              OUTBOUND_EXECUTABLE_QUEUE_NAMES.some((name) => name === row.queue_name)
                ? projectOutboundDelivery(row.queue_name, entry).preparedBatch
                : undefined;
            return {
              id: row.id,
              queue: row.queue_name,
              at: Number(row.updated_at),
              status: row.status,
              recoveryState: row.recovery_state,
              attempts: entry ? resolveDeliveryQueueAttemptCount(entry) : Number(row.retry_count),
              leaseOwnerPresent: Boolean(
                entry?.producerClaimId || entry?.platformSendAttemptId || (entry && "owner" in entry),
              ),
              lastErrorCode: deliveryErrorCode(row.last_error),
              prepared: prepared?.entries
                .slice(0, 3)
                .map((item) =>
                  item.status === "accepted"
                    ? { status: item.status, mediaCount: item.preparedMediaCount }
                    : { status: item.status, reason: item.reason },
                ),
            };
          }),
      { env },
    );
  } catch {
    return "unavailable";
  }
}

export function deliveryQueueDiagnostics(
  gateway: { runtimeEnv: NodeJS.ProcessEnv; logs(): string },
  sessionKeys: string[],
  { ids = [], since = 0 }: { ids?: string[]; since?: number } = {},
) {
  const queue = readQueue(gateway.runtimeEnv, sessionKeys, ids, since);
  const rowIds = new Set([...ids, ...(Array.isArray(queue) ? queue.map(({ id }) => id) : [])]);
  const recovery: Array<{ source: string; rowId?: string; event: string; at?: string }> = [];
  let unmatchedRecoveryEvents = 0;
  let startupLogged = false;
  let enqueueRetryLogged = false;
  const logs = gateway.logs();
  for (const line of logs.split("\n")) {
    if (!line.includes("delivery-recovery]")) {
      continue;
    }
    const at = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})/u.exec(line)?.[0];
    const startup =
      /pending delivery entries — starting recovery|Delivery recovery complete:/u.exec(line);
    if (startup) {
      startupLogged = true;
      recovery.push({ source: "startup", event: startup[0], at });
      continue;
    }
    const message = line.slice(line.indexOf("delivery-recovery]") + "delivery-recovery]".length);
    const enqueueRetry = message.includes("Outbound delivery retry:");
    enqueueRetryLogged ||= enqueueRetry;
    const match =
      /(?:Outbound delivery retry: (?:entry |drained delivery |retry failed for entry )|Retry failed for delivery |Recovery: entry |Recovery skipped for delivery |Recovered delivery |Delivery (?:entry )?)([\w:-]+?)(?=:? |$)/u.exec(
        message,
      );
    const rowId = match?.[1];
    if (!rowId || rowId === "recovery") {
      continue;
    }
    if (!rowIds.has(rowId)) {
      unmatchedRecoveryEvents += 1;
      continue;
    }
    recovery.push({
      source: enqueueRetry ? "enqueue_retry" : "outbound_recovery",
      rowId,
      event: deliveryErrorCode(line) === "unresolved_send" ? "unresolved_send" : "row_observed",
      at,
    });
  }
  return {
    queue,
    startupLogged,
    enqueueRetryLogged,
    recovery: recovery.slice(-6),
    unmatchedRecoveryEvents,
    logTruncated: logs.includes("older gateway logs truncated"),
  };
}

export function createRequestSummary() {
  const counts = new Map<string, { method: string; path: string; count: number }>();
  return {
    record(method: string | undefined, path: string) {
      method = method && /^(?:GET|POST|PUT|PATCH|DELETE|HEAD)$/u.test(method) ? method : "OTHER";
      const key = `${method} ${path}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { method, path, count: 1 });
      }
    },
    snapshot: () => [...counts.values()],
  };
}

export async function rethrowWithDeliveryDiagnostics(
  error: unknown,
  collect: () => unknown | Promise<unknown>,
): Promise<never> {
  if (error instanceof Error) {
    let diagnostics = "unavailable";
    try {
      const bytes = Buffer.from(JSON.stringify(await collect()));
      diagnostics =
        bytes.length > 4_000 ? `${bytes.subarray(0, 4_000).toString()}…` : bytes.toString();
    } catch {
      // A failed diagnostic read must preserve the original assertion and stack.
    }
    error.message += `\nDelivery diagnostics: ${diagnostics}`;
  }
  throw error;
}
