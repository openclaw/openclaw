import type { AgentMessage, SessionTreeEntry } from "@openclaw/agent-core";
import { sql, type AliasableExpression } from "kysely";
import {
  iterateSessionContextEntries,
  iterateSessionContextMessages,
  projectSessionEntryMessage,
} from "../../../packages/agent-core/src/harness/session/session.js";
import {
  classifyToolUseResultPairing,
  isSyntheticMissingToolResult,
  SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { isCompactionReplayCheckpoint } from "../../../packages/ai/src/transports/provider-compaction-checkpoint.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { chunkItems } from "../../utils/chunk-items.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  assertSessionTranscriptContextAnchorInDatabase,
  type TranscriptSourceAuthority,
} from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  readWithCanonicalSessionAdmission,
} from "./session-canonical-key.js";
import { normalizeSessionContextEntryBoundaries } from "./session-entry-navigation.js";
import type {
  SessionModelContextLimits,
  SessionTranscriptModelContext,
} from "./session-history-read.types.js";
import { projectModelContextEventSql } from "./session-model-context-projection.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import {
  transcriptEventJsonSql,
  transcriptEventModelBytesSql,
  transcriptEventModelNavigationSql,
  transcriptEventNavigationSql,
} from "./transcript-payload.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

type ContextEntry = SessionTreeEntry & { seq: number };
export type { SessionModelContextLimits } from "./session-history-read.types.js";
type ModelContextRequest = {
  entry: ContextEntry;
  omitCheckpoint: boolean;
  toolResultOmission?: string;
};
type TranscriptContextSnapshot = {
  header: TranscriptEvent;
  entries: ContextEntry[];
  version: SessionTranscriptContextVersion;
  readEntry: (entry: ContextEntry) => SessionTreeEntry;
  readModelEntrySizes: (requests: readonly ModelContextRequest[]) => Map<ContextEntry, number>;
  readModelEntries: (
    requests: readonly ModelContextRequest[],
  ) => Map<ContextEntry, SessionTreeEntry>;
};

const MODEL_CONTEXT_PAYLOAD_BATCH_SIZE = 400;

/** Later appends are allowed; rewriting or removing the accepted turn is not. */
export function validateSessionTranscriptContextAnchor(
  scope: SessionTranscriptReadScope,
  through: TranscriptEntryAnchor,
  expectedAuthority?: TranscriptSourceAuthority,
): void {
  validateDetachedSessionTranscriptContext(scope, { through, expectedAuthority });
}

/** Unadmitted context retains the prefix captured by its original read snapshot. */
export function validateSessionTranscriptContextVersion(
  scope: SessionTranscriptReadScope,
  version: SessionTranscriptContextVersion | undefined,
): void {
  validateDetachedSessionTranscriptContext(scope, { version });
}

function validateContextVersion(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  version: SessionTranscriptContextVersion | undefined,
  consistency: "exact" | "prefix",
): void {
  const current = readTranscriptContextVersionInTransaction(database, sessionId);
  if (
    current.generation === version?.generation &&
    current.rawSeq === version?.rawSeq &&
    current.updatedAt === version?.updatedAt
  ) {
    return;
  }
  const changed = () =>
    new SessionTranscriptReadFenceError("Session transcript changed during context read");
  if (
    consistency === "exact" ||
    !version?.generation ||
    current.generation !== version.generation ||
    version.rawSeq === null ||
    current.rawSeq === null ||
    current.rawSeq <= version.rawSeq
  ) {
    throw changed();
  }
  // Generation preserves prefix bytes; navigation must also preserve the original path.
  const entries = Array.from(
    iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", transcriptEventModelNavigationSql().as("navigation_json")])
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc"),
    ),
    // SAFETY: The codec's navigation projection preserves entry discriminants and tree links.
    (row) => ({ ...(JSON.parse(row.navigation_json) as SessionTreeEntry), seq: row.seq }),
  );
  const headSeq = version.rawSeq;
  const prefix = scanSessionTranscriptTree(entries.filter((entry) => entry.seq <= headSeq));
  const tree = scanSessionTranscriptTree(entries);
  const suffix = tree.nodes.filter(({ entry }) => entry.seq > headSeq);
  const expected = [...selectSessionTranscriptTreePathNodes(prefix, prefix.leafId), ...suffix];
  const path = selectSessionTranscriptTreePathNodes(tree, tree.leafId);
  if (
    entries.at(-1)?.seq !== current.rawSeq ||
    suffix.some(({ entry }) =>
      ["compaction", "reset", "leaf", "branch_summary"].includes(entry.type),
    ) ||
    expected.length !== path.length ||
    expected.some(
      (node, index) => node.id !== path[index]?.id || node.parentId !== path[index]?.parentId,
    )
  ) {
    throw changed();
  }
}

/** Revalidate admission after an asynchronous read before accepting its detached result. */
export function validateSessionTranscriptContextAdmission(
  scope: SessionTranscriptReadScope,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
): void {
  if (!admission) {
    return;
  }
  validateDetachedSessionTranscriptContext(scope, { admission });
}

type TranscriptContextValidation = {
  version?: SessionTranscriptContextVersion;
  admission?: UserTurnTranscriptAdmissionReceipt;
  through?: TranscriptEntryAnchor;
  expectedAuthority?: TranscriptSourceAuthority;
};

/** Released validators share admission; only multi-statement version reads need a snapshot. */
function validateDetachedSessionTranscriptContext(
  scope: SessionTranscriptReadScope,
  validation: TranscriptContextValidation,
): void {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const validate = () => {
      if (validation.expectedAuthority) {
        assertCanonicalSqliteSessionKeysCurrent(database);
      }
      validateSessionTranscriptContextInDatabase(database, resolved, validation, "prefix");
    };
    return validation.through
      ? readWithCanonicalSessionAdmission(database, validate)
      : validation.admission
        ? validate()
        : runSqliteDeferredTransactionSync(database.db, validate);
  }, toDatabaseOptions(resolved));
  if (!result.found && (validation.through || validation.admission || validation.version)) {
    throw new SessionTranscriptReadFenceError(
      validation.admission
        ? "Current-turn transcript admission is no longer readable"
        : validation.through
          ? "Completed-turn transcript no longer exists"
          : "Session transcript changed during context read",
    );
  }
}

/** Validate detached context using the final reader's transaction-local facts. */
export function validateSessionTranscriptContextInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  validation: TranscriptContextValidation,
  consistency: "exact" | "prefix" = "exact",
): void {
  const { version, admission, through } = validation;
  if (admission) {
    if (
      !runWithSessionTranscriptReadFence(admission, () =>
        resolveSqliteSessionTranscriptReadFence({ database, ...resolved }),
      )
    ) {
      throw new SessionTranscriptReadFenceError(
        "Current-turn transcript admission is no longer readable",
      );
    }
  } else if (!through) {
    validateContextVersion(database, resolved.sessionId, version, consistency);
  }
  if (through) {
    assertSessionTranscriptContextAnchorInDatabase(
      database,
      resolved,
      through,
      validation.expectedAuthority,
    );
  }
}

/** Select an owned suffix before SQLite payloads can enter JavaScript or cross a worker. */
function selectBoundedModelRequests(
  requests: ModelContextRequest[],
  readSizes: TranscriptContextSnapshot["readModelEntrySizes"],
  limits: SessionModelContextLimits,
): ModelContextRequest[] {
  const boundary = requests.find(
    ({ entry }) => entry.type === "compaction" || entry.type === "reset",
  );
  const candidates = requests.filter((request) => request !== boundary);
  const sizingCandidates = candidates.slice(-limits.maxEvents);
  const sizes = readSizes(boundary ? [boundary, ...sizingCandidates] : sizingCandidates);
  let bytes = boundary ? sizes.get(boundary.entry)! : 0;
  let events = boundary ? 1 : 0;
  if (bytes > limits.maxBytes || events > limits.maxEvents) {
    throw new RangeError("Required session context boundary exceeds the model-context limit");
  }
  let cut = candidates.length;
  for (const request of sizingCandidates.toReversed()) {
    const size = sizes.get(request.entry)!;
    if (bytes + size > limits.maxBytes || events + 1 > limits.maxEvents) {
      break;
    }
    bytes += size;
    events += 1;
    cut -= 1;
  }
  if (cut === 0) {
    return requests;
  }
  const messages = candidates.flatMap(({ entry }) => {
    const message = entry.type === "message" ? entry.message : projectSessionEntryMessage(entry);
    return message ? [message] : [];
  });
  const positions = new Map<AgentMessage, number>();
  for (const [index, { entry }] of candidates.entries()) {
    if (entry.type === "message") {
      positions.set(entry.message, index);
    }
  }
  const original = classifyToolUseResultPairing(messages);
  const owners = new Map<AgentMessage, AgentMessage>();
  // Occurrence ownership, including displaced results, forbids cuts through a tool frame.
  // Frames are ordered by their assistant, so advancing the cut needs only one pass.
  for (const frame of original.frames) {
    const start = positions.get(frame.assistant)!;
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResult) {
        owners.set(occurrence.sourceResult, frame.assistant);
        const end = positions.get(occurrence.sourceResult)!;
        if (start < cut && cut <= end) {
          cut = end + 1;
        }
      }
    }
  }
  let selected = candidates.slice(cut);
  if (selected.length === 0 && limits.toolResultOverflow === "omit") {
    // Retain the newest historical request and close its suffix over displaced results.
    // The currently admitted user is supplied separately by native runtime callers.
    let start = candidates.findLastIndex(
      ({ entry }) => entry.type === "message" && entry.message.role === "user",
    );
    if (start < 0) {
      start = candidates.length - 1;
    }
    for (const frame of original.frames.toReversed()) {
      if (
        frame.occurrences.some(
          ({ sourceResult }) => sourceResult && positions.get(sourceResult)! >= start,
        )
      ) {
        start = Math.min(start, positions.get(frame.assistant)!);
      }
    }
    const required = candidates.slice(start);
    if (required.length + (boundary ? 1 : 0) <= limits.maxEvents) {
      const requiredSizes = readSizes(boundary ? [boundary, ...required] : required);
      let requiredBytes = [...requiredSizes.values()].reduce((total, size) => total + size, 0);
      const omissions = required.flatMap((request) => {
        const { entry } = request;
        if (entry.type !== "message" || entry.message.role !== "toolResult") {
          return [];
        }
        const message = entry.message;
        return [
          {
            ...request,
            toolResultOmission:
              `Tool result body omitted from this bounded context: ${JSON.stringify(message.toolName)} ` +
              `(call ${JSON.stringify(message.toolCallId)}), original model-context event ${requiredSizes.get(entry)!} bytes. ` +
              "The full result remains in the session transcript. Do not infer its outcome or repeat the operation from this notice.",
          },
        ];
      });
      const omittedSizes = readSizes(omissions);
      const savings = (request: ModelContextRequest) =>
        requiredSizes.get(request.entry)! - omittedSizes.get(request.entry)!;
      const replacements = new Map<ContextEntry, ModelContextRequest>();
      for (const omission of omissions.toSorted((a, b) => savings(b) - savings(a))) {
        if (requiredBytes <= limits.maxBytes) {
          break;
        }
        const saved = savings(omission);
        if (saved > 0) {
          replacements.set(omission.entry, omission);
          requiredBytes -= saved;
        }
      }
      if (requiredBytes <= limits.maxBytes) {
        selected = required.map((request) => replacements.get(request.entry) ?? request);
      }
    }
  }
  if (selected.length === 0) {
    throw new RangeError(
      "The latest messages exceed this session's context limit. Start a new session with a brief summary to continue.",
    );
  }
  const selectedMessages = selected.flatMap(({ entry }) =>
    entry.type === "message" ? [entry.message] : [],
  );
  // Removing an older repeated ID must not turn an ambiguous result into a different call's result.
  const selectedOwners = new Map<AgentMessage, AgentMessage>();
  for (const frame of classifyToolUseResultPairing(selectedMessages).frames) {
    for (const occurrence of frame.occurrences) {
      if (occurrence.sourceResult) {
        selectedOwners.set(occurrence.sourceResult, frame.assistant);
      }
    }
  }
  for (const message of selectedMessages) {
    if (message.role === "toolResult" && owners.get(message) !== selectedOwners.get(message)) {
      throw new RangeError("Session context limit would change tool-result ownership");
    }
  }
  return boundary ? [boundary, ...selected] : selected;
}

function modelContextBatchSql(requests: readonly ModelContextRequest[]) {
  const bySeq = new Map(requests.map(({ entry }) => [entry.seq, entry]));
  const omitted = requests.flatMap(({ entry, omitCheckpoint }) =>
    omitCheckpoint ? [entry.seq] : [],
  );
  const omitCheckpoint = omitted.length
    ? /* kysely-allow-raw: checkpoint omission is scoped to bound row identities in this payload batch. */ sql<number>`seq IN (${sql.join(omitted)})`
    : sql.lit(0);
  const omissions = requests.flatMap(({ entry, toolResultOmission }) =>
    toolResultOmission ? [sql`WHEN ${entry.seq} THEN ${toolResultOmission}`] : [],
  );
  const omission = omissions.length
    ? /* kysely-allow-raw: owned row identities and omission notices are bound values, not SQL text. */ sql<
        string | null
      >`CASE seq ${sql.join(omissions, sql` `)} ELSE NULL END`
    : undefined;
  return { bySeq, omitCheckpoint, omission };
}

/** Read a transient context without opening the writer lifecycle or copying native evidence. */
export function readSessionTranscriptModelContext(
  scope: SessionTranscriptReadScope,
  through?: TranscriptEntryAnchor,
  limits?: SessionModelContextLimits,
): SessionTranscriptModelContext {
  if (
    limits &&
    (!Number.isSafeInteger(limits.maxBytes) ||
      limits.maxBytes <= 0 ||
      !Number.isSafeInteger(limits.maxEvents) ||
      limits.maxEvents <= 0)
  ) {
    throw new RangeError("Model-context byte and event limits must be positive safe integers");
  }
  const result = withTranscriptContextSnapshot(
    scope,
    ({ header, entries, readModelEntries, readModelEntrySizes, version }) => {
      const requests: ModelContextRequest[] = [];
      for (const { entry, context } of iterateSessionContextEntries(entries)) {
        const omitCheckpoint =
          context !== "current" &&
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          isCompactionReplayCheckpoint(entry.message.providerReplay);
        requests.push({ entry, omitCheckpoint });
      }
      const selected = limits
        ? selectBoundedModelRequests(requests, readModelEntrySizes, limits)
        : requests;
      const payloads = readModelEntries(selected);
      let contextEntries: SessionTreeEntry[];
      if (limits) {
        const model = entries.findLast(
          (entry) =>
            entry.type === "model_change" ||
            (entry.type === "message" && entry.message.role === "assistant"),
        );
        const thinking = entries.findLast((entry) => entry.type === "thinking_level_change");
        const detached = entries.flatMap((entry) => {
          const payload = payloads.get(entry);
          if (payload) {
            return [payload];
          }
          if (entry === thinking || (entry === model && entry.type === "model_change")) {
            return [entry];
          }
          if (entry === model && entry.type === "message" && entry.message.role === "assistant") {
            return [
              {
                type: "model_change" as const,
                id: entry.id,
                parentId: entry.parentId,
                timestamp: entry.timestamp,
                provider: entry.message.provider,
                modelId: entry.message.model,
              },
            ];
          }
          return [];
        });
        const boundaryIndex = detached.findIndex(
          (entry) => entry.type === "compaction" || entry.type === "reset",
        );
        const boundary = detached[boundaryIndex];
        if (boundary?.type === "compaction" || boundary?.type === "reset") {
          boundary.firstKeptEntryId =
            detached
              .slice(0, boundaryIndex)
              .find(
                (entry) =>
                  entry.type === "message" ||
                  entry.type === "custom_message" ||
                  entry.type === "branch_summary",
              )?.id ?? boundary.id;
        }
        contextEntries = detached.map((entry, index) => {
          entry.parentId = detached[index - 1]?.id ?? null;
          return entry;
        });
      } else {
        contextEntries = entries.map((entry) => payloads.get(entry) ?? entry);
      }
      return {
        events: [...(header ? [header] : []), ...contextEntries],
        version,
      };
    },
    through,
  );
  return result.found ? result.value : { events: [] };
}

/** Consume full-fidelity context lazily inside one read snapshot, never retaining raw history. */
export function readSessionTranscriptContextMessages<T>(
  scope: SessionTranscriptReadScope,
  read: (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => T,
): T {
  const result = withTranscriptContextSnapshot(scope, ({ header, entries, readEntry, version }) => {
    const messages = iterateSessionContextMessages(entries, readEntry);
    try {
      return read(messages, header, version);
    } finally {
      // Retained iterators cannot read after the snapshot closes, including early rejection.
      messages.return(undefined);
    }
  });
  return result.found ? result.value : read([], undefined);
}

function withTranscriptContextSnapshot<T>(
  scope: SessionTranscriptReadScope,
  read: (snapshot: TranscriptContextSnapshot) => T,
  through?: TranscriptEntryAnchor,
): { found: true; value: T } | { found: false } {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  return withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const db = getSessionKysely(database.db);
          const role = db.fn("json_extract", [
            transcriptEventNavigationSql(),
            sql.val("$.message.role"),
          ]);
          const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
          const version = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
          if (through) {
            assertSessionTranscriptContextAnchorInDatabase(database, resolved, through);
          }
          const base = db
            .selectFrom("transcript_events")
            .where("session_id", "=", resolved.sessionId)
            .$if(fence !== undefined, (query) => query.where("seq", "<", fence!.beforeRawSeq))
            .$if(through !== undefined, (query) => query.where("seq", "<=", through!.rawSeq));
          const header = executeSqliteQueryTakeFirstSync(
            database.db,
            base
              .select(transcriptEventJsonSql(database.db).as("event_json"))
              .where(
                /* kysely-allow-raw: the header discriminator is owned by the transcript codec. */
                sql<string>`json_extract(${transcriptEventNavigationSql()}, '$.type')`,
                "=",
                "session",
              )
              .orderBy("seq", "asc")
              .limit(1),
          );
          const tree = scanSessionTranscriptTree(
            (function* () {
              for (const row of iterateSqliteQuerySync(
                database.db,
                base
                  .select(["seq", transcriptEventModelNavigationSql().as("navigation_json")])
                  .orderBy("seq", "asc"),
              )) {
                // Only navigation crosses into JavaScript before the canonical context is selected.
                // SAFETY: SQL preserves entry discriminants and replaces payloads with readable empty bodies.
                yield { ...(JSON.parse(row.navigation_json) as SessionTreeEntry), seq: row.seq };
              }
            })(),
          );
          // Navigation entries belong to this snapshot; normalize ancestry without another copy.
          if (through && !tree.byId.has(through.entryId)) {
            throw new SessionTranscriptReadFenceError(
              "Completed-turn anchor is outside the admitted context",
            );
          }
          const entries = normalizeSessionContextEntryBoundaries(
            selectSessionTranscriptTreePathNodes(tree, through?.entryId ?? tree.leafId).map(
              ({ entry, parentId }) => {
                entry.parentId = parentId;
                return entry;
              },
            ),
            tree.nodes,
          );
          const readPayload = prepareSqliteQuerySync<ContextEntry, { event_json: string }>(
            database.db,
            (parameter) =>
              base.select(transcriptEventJsonSql(database.db).as("event_json")).where(
                "seq",
                "=",
                parameter((row) => row.seq),
              ),
          );
          return read({
            header: header ? JSON.parse(header.event_json) : undefined,
            entries,
            version,
            readEntry: (entry) => {
              const row = readPayload(entry).rows[0];
              return hydrateContextEntry(row!.event_json, entry);
            },
            readModelEntrySizes: (requests) => {
              const sizes = new Map<ContextEntry, number>();
              for (const batch of chunkItems(requests, MODEL_CONTEXT_PAYLOAD_BATCH_SIZE)) {
                const { bySeq, omitCheckpoint, omission } = modelContextBatchSql(batch);
                const query = base
                  .select((eb) => {
                    const storedBytes = transcriptEventModelBytesSql(omitCheckpoint);
                    // Stored costs describe the original model view, not a transient omission notice.
                    const bytes: AliasableExpression<number> = omission
                      ? eb
                          .case()
                          .when(omission, "is not", null)
                          .then(
                            eb.fn<number>("octet_length", [
                              projectModelContextEventSql(
                                transcriptEventJsonSql(database.db),
                                omitCheckpoint,
                                omission,
                                role,
                              ),
                            ]),
                          )
                          .else(storedBytes)
                          .end()
                      : storedBytes;
                    return ["seq", bytes.as("bytes")];
                  })
                  .where("seq", "in", [...bySeq.keys()]);
                for (const row of iterateSqliteQuerySync(database.db, query)) {
                  sizes.set(bySeq.get(row.seq)!, row.bytes);
                }
              }
              return sizes;
            },
            readModelEntries: (requests) => {
              const payloads = new Map<ContextEntry, SessionTreeEntry>();
              for (const batch of chunkItems(requests, MODEL_CONTEXT_PAYLOAD_BATCH_SIZE)) {
                const { bySeq, omitCheckpoint, omission } = modelContextBatchSql(batch);
                // Bound both IN lists while keeping payload selection inside the navigation snapshot.
                // SQL removes obsolete replay/private fields before they enter JavaScript.
                const query = base
                  .select([
                    "seq",
                    projectModelContextEventSql(
                      transcriptEventJsonSql(database.db),
                      omitCheckpoint,
                      omission,
                      role,
                    ).as("event_json"),
                  ])
                  .where("seq", "in", [...bySeq.keys()]);
                for (const row of iterateSqliteQuerySync(database.db, query)) {
                  const entry = bySeq.get(row.seq)!;
                  const hydrated = hydrateContextEntry(row.event_json, entry);
                  if (
                    entry.type === "message" &&
                    entry.message.role === "toolResult" &&
                    isSyntheticMissingToolResult(entry.message) &&
                    hydrated.type === "message" &&
                    hydrated.message.role === "toolResult"
                  ) {
                    // Retain pairing provenance after SQL removes opaque tool details.
                    hydrated.message.details = { [SYNTHETIC_MISSING_TOOL_RESULT_DETAIL_KEY]: true };
                  }
                  payloads.set(entry, hydrated);
                }
              }
              return payloads;
            },
          });
        },
        { operationLabel: "session context snapshot read" },
      ),
    toDatabaseOptions(resolved),
  );
}

function hydrateContextEntry(eventJson: string, entry: ContextEntry): SessionTreeEntry {
  return {
    // SAFETY: The canonical payload is selected by its navigation row in the same snapshot.
    ...(JSON.parse(eventJson) as SessionTreeEntry),
    parentId: entry.parentId,
    ...((entry.type === "compaction" || entry.type === "reset") &&
    entry.firstKeptEntryId !== undefined
      ? { firstKeptEntryId: entry.firstKeptEntryId }
      : {}),
  };
}
