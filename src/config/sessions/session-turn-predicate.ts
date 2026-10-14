import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { extractAssistantPhaseText } from "../../shared/chat-message-content.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptTurnMutation } from "./goals-operations.types.js";
import { prepareExactSessionEntryRowReads } from "./session-accessor.sqlite-entry-read.js";
import {
  findAssistantTranscriptEventInDatabase,
  readTranscriptEventMessage,
} from "./session-accessor.sqlite-read.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import type { SessionTranscriptTurnMessageAppend } from "./session-accessor.types.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SqliteSessionTurnOptions } from "./session-turn.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

let resolveSessionWorkStartError:
  | typeof import("./lifecycle.js").resolveSessionWorkStartError
  | undefined;
let readGatewaySessionStore: typeof import("../../gateway/session-utils-store-read.js").readGatewaySessionStore;
let prepareRoutingLookup:
  | typeof import("../../gateway/session-utils-store-lookup.js").prepareGatewaySessionStoreTargetLookup
  | undefined;

export async function prepareSessionTurnPredicates() {
  resolveSessionWorkStartError = (await import("./lifecycle.js")).resolveSessionWorkStartError;
  const { prepareGatewaySessionStoreTargetLookup } =
    await import("../../gateway/session-utils-store-lookup.js");
  prepareRoutingLookup = prepareGatewaySessionStoreTargetLookup;
  ({ readGatewaySessionStore } = await import("../../gateway/session-utils-store-read.js"));
}

export function prepareSessionTurnRouting(
  predicate: SessionTranscriptTurnMutation["routingPredicate"],
  env?: NodeJS.ProcessEnv,
): ((database: OpenClawAgentDatabase) => void) | undefined {
  if (!predicate) {
    return undefined;
  }
  if (!prepareRoutingLookup) {
    throw new Error("Session turn predicates were not prepared");
  }
  let current: OpenClawAgentDatabase | undefined;
  const lookup = prepareRoutingLookup({
    cfg: predicate.config,
    env,
    key: predicate.key,
    agentId: predicate.agentId,
    exactRead: true,
    readOnly: true,
    projection: "list",
    readStore(read) {
      if (!current) {
        throw new Error("Session routing requires its transaction database");
      }
      if (!isSameOpenClawAgentDatabasePath(paths.get(read)!, current.path)) {
        return readGatewaySessionStore(read);
      }
      const keys = read.options.exactKeys ?? [];
      const row = prepareExactSessionEntryRowReads(current, keys, "list");
      return Object.fromEntries(
        keys.flatMap((key) => {
          const entry = row(key)?.entry;
          return entry ? [[key, entry]] : [];
        }),
      );
    },
  });
  // Resolve locators before BEGIN; the predicate rereads rows on the transaction connection.
  const paths = new Map(
    lookup.reads.map((read) => [
      read,
      resolveSqliteTargetFromSessionStorePath(read.storePath, { agentId: read.agentId, env }).path,
    ]),
  );
  return (database) => {
    current = database;
    const target = lookup.resolve();
    if (
      target.storePath !== predicate.storePath ||
      target.canonicalKey !== predicate.canonicalKey
    ) {
      throw new Error("Session routing changed before Goal admission; refresh and retry.");
    }
  };
}

export function sessionTurnPredicateMatches(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  predicate: SessionTranscriptTurnMessageAppend["predicate"],
): boolean {
  if (!predicate) {
    return true;
  }
  if (predicate.kind === "active-entry") {
    if (
      !readActiveTranscriptEntryAnchorInTransaction({
        database,
        resolved,
        entryId: predicate.entryId,
      })
    ) {
      throw new Error(predicate.errorMessage);
    }
    return true;
  }
  const latest = findAssistantTranscriptEventInDatabase(database, resolved.sessionId);
  const message = latest ? readTranscriptEventMessage(latest.event) : undefined;
  return (
    resolveTerminalAssistantTranscriptRunId(message, readSessionTranscriptRunId(message)) !==
      predicate.runId || extractAssistantPhaseText(message)?.trim() !== predicate.text
  );
}

export function assertSessionTurnAcceptedResult(
  sessionKey: string,
  entry: SessionEntry,
  options: SqliteSessionTurnOptions,
): void {
  const guard = options.acceptedResultGuard;
  if (!guard) {
    return;
  }
  if (entry.activeWriterRunId !== (guard.expectedWriterRunId ?? undefined)) {
    throw new Error(guard.errorMessage);
  }
  if (!resolveSessionWorkStartError) {
    throw new Error("Session turn predicates were not prepared");
  }
  const error = resolveSessionWorkStartError(sessionKey, entry, {
    expectedSessionId: options.expectedSessionId,
    purpose: "accepted-result-settlement",
  });
  if (error) {
    throw new Error(error);
  }
}
