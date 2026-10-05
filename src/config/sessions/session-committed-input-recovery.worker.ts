import { createHash } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { selectMainSessionRecoveryCheckpoint } from "../../agents/main-session-recovery/main-session-recovery-checkpoint.js";
import { readTranscriptSenderIdentity } from "../../chat/sender-identity.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import { readRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.metadata.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { hasRestartRecoveryTerminalRun } from "./restart-recovery-state.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import type { SessionTranscriptMessageEvent } from "./session-accessor.sqlite-projection-read.js";
import {
  iterateVisibleMessageRange,
  resolveVisibleMessagePositions,
} from "./session-accessor.sqlite-reset-window.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { CommittedRecoveryInputSnapshot } from "./session-pending-input-operations.types.js";

/** Stored profile provenance identifies the turn; it never issues execution authority. */
export function readCommittedRecoveryInputInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "path" | "db">,
  target: { sessionKey: string; sessionId: string },
): CommittedRecoveryInputSnapshot {
  if (isMainThread) {
    throw new Error("Committed input recovery requires the existing session database worker");
  }
  const entry = readSessionEntryRow(database, target.sessionKey)?.entry;
  if (entry?.sessionId !== target.sessionId) {
    return { kind: "committed-recovery", current: false };
  }
  const snapshot = readCurrentProjectionSnapshot(
    database,
    resolveSqliteTranscriptReadScope({
      ...target,
      agentId: database.agentId,
      storePath: database.path,
    }),
    (projection) => {
      const total = resolveVisibleMessagePositions(projection).total;
      let last: SessionTranscriptMessageEvent | undefined;
      let tail: SessionTranscriptMessageEvent | undefined;
      for (const item of iterateVisibleMessageRange(projection, 0, total)) {
        tail = item;
        if (
          isRecord(item.event) &&
          isRecord(item.event.message) &&
          item.event.message.role === "user"
        ) {
          last = item;
        }
      }
      const event = last && isRecord(last.event) ? last.event : undefined;
      const message = event && isRecord(event.message) ? event.message : undefined;
      const metadata = asOptionalRecord(message?.["__openclaw"]);
      const sender = readTranscriptSenderIdentity(metadata?.senderIdentity);
      const runId = readRunUserTurnIdempotencyKey(message?.idempotencyKey);
      if (!last || !event || typeof event.id !== "string" || message?.role !== "user") {
        return { input: undefined };
      }
      if (
        entry.mainRestartRecovery?.turnIntent?.inputId === event.id &&
        entry.mainRestartRecovery.queuedInputId !== event.id
      ) {
        // The already captured predecessor belongs to its existing recovery owner.
        return { input: undefined };
      }
      const committedAt =
        typeof event.timestamp === "string" ? Date.parse(event.timestamp) : Number.NaN;
      const pendingAt = getAdmittedSqliteSchemaFacts(database.db)?.tables.has(
        "session_pending_inputs",
      )
        ? executeSqliteQueryTakeFirstSync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_pending_inputs")
              .select(({ fn }) => fn.max<number>("accepted_at").as("acceptedAt"))
              .where("session_key", "=", target.sessionKey)
              .where("session_id", "=", target.sessionId)
              .where("consumed_event_id", "is", null)
              .where("state", "!=", "cancelled"),
          )?.acceptedAt
        : undefined;
      if (!Number.isFinite(committedAt) || (pendingAt != null && pendingAt > committedAt)) {
        return { blocked: true as const };
      }
      if (
        typeof message.content !== "string" ||
        typeof message.idempotencyKey !== "string" ||
        !runId ||
        sender?.type !== "profile" ||
        typeof sender.id !== "string" ||
        metadata?.senderId !== sender.id ||
        hasRestartRecoveryTerminalRun(entry, runId)
      ) {
        return { blocked: true as const };
      }
      const effects = selectMainSessionRecoveryCheckpoint(
        (visit) => {
          for (const item of iterateVisibleMessageRange(projection, 0, total)) {
            if (isRecord(item.event) && item.event.message !== undefined) {
              visit(item.event.message);
            }
          }
        },
        undefined,
        undefined,
        true,
      );
      if (effects.unresolvedEffect) {
        return { effectHold: true as const };
      }
      if (tail?.eventSeq !== last.eventSeq) {
        return { blocked: true as const };
      }
      return {
        input: {
          inputId: event.id,
          runId,
          idempotencyKey: message.idempotencyKey,
          profileId: sender.id,
          fingerprint: createHash("sha256")
            .update(JSON.stringify([last.eventSeq, event]))
            .digest("hex"),
        },
      };
    },
  );
  if (snapshot.kind !== "value") {
    throw new Error("Committed recovery transcript is unavailable");
  }
  return { kind: "committed-recovery", current: true, ...snapshot.value };
}
