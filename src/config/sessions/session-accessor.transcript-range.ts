import { Buffer } from "node:buffer";
import { toUSVString } from "node:util";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { TranscriptEntryAnchor, TranscriptTurnBoundary } from "./transcript-entry-anchor.js";

export type ClosedTranscriptTurnReadResult =
  | {
      kind: "ok";
      messages: AgentMessage[];
    }
  | {
      kind: "non-descendant" | "projection-unavailable" | "session-rebound" | "stale" | "too-large";
    };

function anchorsShareTarget(boundary: TranscriptTurnBoundary): boolean {
  const { admission, terminal } = boundary;
  return (
    admission.agentId === terminal.agentId &&
    admission.sessionId === terminal.sessionId &&
    admission.sessionKey === terminal.sessionKey &&
    admission.storePath === terminal.storePath &&
    admission.generation === terminal.generation
  );
}

function validateAnchorRow(
  anchor: TranscriptEntryAnchor,
  row:
    | {
        event_json: string;
        generation: string;
        message_position: number | null;
        parent_id: string | null;
        seq: number;
      }
    | undefined,
): boolean {
  return Boolean(
    row &&
    row.generation === anchor.generation &&
    row.seq === anchor.rawSeq &&
    row.parent_id === anchor.effectiveParentId &&
    row.message_position === anchor.activeMessagePosition,
  );
}

function validateTerminalAncestry(params: {
  database: Parameters<typeof getSessionKysely>[0];
  sessionId: string;
  admissionEntryId: string;
  terminalEntryId: string;
  terminalParentId: string | null;
  maxDepth: number;
}): "descendant" | "non-descendant" | "too-large" {
  if (params.terminalEntryId === params.admissionEntryId) {
    return "descendant";
  }
  if (!(params.maxDepth > 0)) {
    return "too-large";
  }
  if (params.terminalParentId === params.admissionEntryId) {
    return "descendant";
  }
  if (params.terminalParentId === null || params.terminalParentId === params.terminalEntryId) {
    return "non-descendant";
  }
  const db = getSessionKysely(params.database);
  const depthLimit = Math.ceil(params.maxDepth);
  // Bound anchor IDs must not normalize lone surrogates into a different stored ID.
  const admissionIsSqlText = toUSVString(params.admissionEntryId) === params.admissionEntryId;
  const terminalIsSqlText = toUSVString(params.terminalEntryId) === params.terminalEntryId;
  const ancestry = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .withRecursive("turn_ancestors", (query) =>
        query
          .selectFrom("transcript_event_identities")
          .select(["event_id", "parent_id"])
          .where("session_id", "=", params.sessionId)
          .where("event_id", "=", params.terminalParentId)
          // UNION deduplicates identities so cycles terminate within the existing depth budget.
          .union(
            query
              .selectFrom("transcript_event_identities as identity")
              .innerJoin("turn_ancestors as previous", "identity.event_id", "previous.parent_id")
              .select(["identity.event_id", "identity.parent_id"])
              .where("identity.session_id", "=", params.sessionId)
              .$if(admissionIsSqlText, (ancestors) =>
                ancestors.where("previous.parent_id", "!=", params.admissionEntryId),
              )
              .$if(terminalIsSqlText, (ancestors) =>
                ancestors.where("identity.event_id", "!=", params.terminalEntryId),
              ),
          )
          .limit(Number.isSafeInteger(depthLimit) ? depthLimit : -1),
      )
      .selectFrom("turn_ancestors")
      .select((eb) => [
        eb.fn.countAll<number>().as("depth"),
        eb.fn
          .max(
            eb
              .case()
              .when(
                eb.and([
                  eb.val(admissionIsSqlText ? 1 : 0),
                  eb("parent_id", "=", params.admissionEntryId),
                ]),
              )
              .then(1)
              .else(0)
              .end(),
          )
          .as("found"),
      ]),
  )!;
  // The original walk checks a fetched parent at the start of its next iteration.
  if (ancestry.depth >= depthLimit) {
    return "too-large";
  }
  return ancestry.found === 1 ? "descendant" : "non-descendant";
}

/** Reads one bounded accepted transcript range from a single SQLite snapshot. */
export function readClosedTranscriptTurn(params: {
  boundary: TranscriptTurnBoundary;
  maxEvents: number;
  maxBytes: number;
}): ClosedTranscriptTurnReadResult {
  if (!anchorsShareTarget(params.boundary)) {
    return { kind: "session-rebound" };
  }
  const target = params.boundary.admission;
  const resolved = resolveSqliteTranscriptScope({
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
  });
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      const db = getSessionKysely(database.db);
      const binding = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_windows")
          .select(["session_id"])
          .where("session_id", "=", target.sessionId)
          .where("session_key", "=", target.sessionKey)
          .limit(1),
      );
      if (!binding) {
        return { kind: "session-rebound" } as const;
      }
      const frontier = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("transcript_events")
          .select("seq")
          .where("session_id", "=", target.sessionId)
          .orderBy("seq", "desc")
          .limit(1),
      )?.seq;
      const projection = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_transcript_index_state")
          .select(["indexed_seq", "needs_rebuild"])
          .where("session_id", "=", target.sessionId),
      );
      if (
        frontier === undefined ||
        !projection ||
        projection.needs_rebuild !== 0 ||
        projection.indexed_seq !== frontier
      ) {
        return { kind: "projection-unavailable" } as const;
      }
      const readAnchor = (anchor: TranscriptEntryAnchor) =>
        executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("session_transcript_active_events as active", (join) =>
              join
                .onRef("active.session_id", "=", "identity.session_id")
                .onRef("active.event_seq", "=", "identity.seq"),
            )
            .innerJoin("transcript_rewrite_watermarks as rewrite", (join) =>
              join.onRef("rewrite.session_id", "=", "identity.session_id"),
            )
            .innerJoin("transcript_events as event", (join) =>
              join
                .onRef("event.session_id", "=", "identity.session_id")
                .onRef("event.seq", "=", "identity.seq"),
            )
            .select([
              "identity.seq",
              "identity.parent_id",
              "active.message_position",
              "rewrite.generation",
              "event.event_json",
            ])
            .where("identity.session_id", "=", target.sessionId)
            .where("identity.event_id", "=", anchor.entryId)
            .limit(1),
        );
      const admissionRow = readAnchor(params.boundary.admission);
      const terminalRow = readAnchor(params.boundary.terminal);
      if (
        !validateAnchorRow(params.boundary.admission, admissionRow) ||
        !validateAnchorRow(params.boundary.terminal, terminalRow)
      ) {
        return { kind: "stale" } as const;
      }
      const admissionEvent = JSON.parse(admissionRow!.event_json) as {
        message?: { role?: unknown };
        type?: unknown;
      };
      if (admissionEvent.type !== "message" || admissionEvent.message?.role !== "user") {
        return { kind: "stale" } as const;
      }
      const ancestry = validateTerminalAncestry({
        database: database.db,
        sessionId: target.sessionId,
        admissionEntryId: params.boundary.admission.entryId,
        terminalEntryId: params.boundary.terminal.entryId,
        terminalParentId: terminalRow!.parent_id,
        maxDepth: params.maxEvents,
      });
      if (ancestry !== "descendant") {
        return { kind: ancestry } as const;
      }
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_active_events as active")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "active.session_id")
              .onRef("event.seq", "=", "active.event_seq"),
          )
          .select("event.event_json")
          .where("active.session_id", "=", target.sessionId)
          .where("active.message_position", "is not", null)
          .where("active.message_position", ">=", params.boundary.admission.activeMessagePosition)
          .where("active.message_position", "<=", params.boundary.terminal.activeMessagePosition)
          .orderBy("active.message_position", "asc")
          // Read one sentinel row so an oversized turn is rejected without
          // materializing the rest of its transcript payload.
          .limit(params.maxEvents + 1),
      ).rows;
      if (
        rows.length > params.maxEvents ||
        rows.reduce((total, row) => total + Buffer.byteLength(row.event_json, "utf8"), 0) >
          params.maxBytes
      ) {
        return { kind: "too-large" } as const;
      }
      const messages = rows.flatMap((row) => {
        const event = JSON.parse(row.event_json) as { message?: unknown; type?: unknown };
        return event.type === "message" && event.message ? [event.message as AgentMessage] : [];
      });
      return {
        kind: "ok",
        messages,
      } as const;
    },
    {
      databaseLabel: database.path,
      operationLabel: "session transcript accepted turn read",
    },
  );
}
