import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import {
  hasTranscriptArchiveInDatabase,
  listTranscriptArchivesFromDatabase,
} from "./session-accessor.sqlite-archive-read.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import type {
  TranscriptArchivePageBinding,
  TranscriptArchivePageOptions,
  TranscriptArchivePageResult,
} from "./session-accessor.sqlite-archive-types.js";
import {
  runSqliteTranscriptArchivePageWorker,
  runSqliteTranscriptArchiveReadWorker,
} from "./session-accessor.sqlite-archive.js";
import type {
  SessionAccessScope,
  SessionTranscriptInstance,
  SessionTranscriptInstanceListOptions,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  getSessionKysely,
  prepareSqliteScope,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
  DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
  MAX_VISIBLE_MESSAGE_MAX_BYTES,
  MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
  normalizeVisibleMessageLimit,
} from "./session-accessor.sqlite-visible-cursor.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import { withSessionHistoryWorkerReadCandidates } from "./session-transcript-worker-resources.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { SessionEntry } from "./types.js";

export async function readSessionTaskArchivePageReadOnly(
  scope: SessionAccessScope,
  options: TranscriptArchivePageOptions,
): Promise<TranscriptArchivePageResult | undefined> {
  return readTaskArchivePage(scope, options);
}

/** Revalidate retained bytes and unique run membership before disclosing a prepared page. */
export async function verifySessionTranscriptArchivePageBindingReadOnly(
  scope: SessionAccessScope,
  runId: string,
  binding: TranscriptArchivePageBinding,
): Promise<void> {
  const result = await readTaskArchivePage(scope, { runId }, binding);
  if (!result) {
    throw new Error("Archived transcript is no longer available.");
  }
}

async function readTaskArchivePage(
  scope: SessionAccessScope,
  options: TranscriptArchivePageOptions,
  verifyBinding?: TranscriptArchivePageBinding,
): Promise<TranscriptArchivePageResult | undefined> {
  const resolved = resolveSqliteReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const limit = normalizeVisibleMessageLimit(
    options.limit,
    DEFAULT_VISIBLE_MESSAGE_MAX_MESSAGES,
    MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
    "limit",
  );
  const maxBytes = normalizeVisibleMessageLimit(
    options.maxBytes,
    DEFAULT_VISIBLE_MESSAGE_MAX_BYTES,
    MAX_VISIBLE_MESSAGE_MAX_BYTES,
    "maxBytes",
  );
  const contextMaxMessages =
    options.contextMaxMessages === undefined
      ? 0
      : normalizeVisibleMessageLimit(
          options.contextMaxMessages,
          0,
          MAX_VISIBLE_MESSAGE_MAX_MESSAGES,
          "contextMaxMessages",
        );
  return withSqliteTranscriptArchiveSession(databaseOptions, async () => {
    const [result] = await runSqliteTranscriptArchivePageWorker([
      {
        agentId: databaseOptions.agentId,
        databasePath: resolveOpenClawAgentSqlitePath(databaseOptions),
        logicalAgentId: resolved.agentId,
        sessionKey: scope.sessionKey,
        runId: options.runId,
        cursor: options.cursor,
        limit,
        maxBytes,
        contextMaxMessages,
        verifyBinding,
        projectionSources: options.projectionSources,
      },
    ]);
    return result;
  });
}

export function listTranscriptInstancesFromDatabase(params: {
  currentEntries: Pick<ReadonlyMap<string, SessionEntry>, "get">;
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">;
  options: SessionTranscriptInstanceListOptions;
}): SessionTranscriptInstance[] {
  const db = getSessionKysely(params.database.db);
  let query = db
    .selectFrom("session_windows")
    .select([
      "session_id",
      "session_key",
      "created_at",
      "updated_at",
      "channel",
      "account_id",
      "transcript_updated_at",
      "session_entry_provenance",
      "acp_owned",
      "plugin_owner_id",
      "hook_external_content_source",
      "parent_session_key",
      "spawned_by",
      "chat_type",
    ]);
  if (!params.options.includeAllWindows) {
    query = query.where("transcript_updated_at", "is not", null);
  }
  if (params.options.sessionId !== undefined) {
    query = query.where("session_id", "=", params.options.sessionId);
  }
  const rows = executeSqliteQuerySync(
    params.database.db,
    query.orderBy("transcript_updated_at", "desc").orderBy("session_id", "asc"),
  ).rows;
  return rows
    .map((row): SessionTranscriptInstance | undefined => {
      if (!params.options.includeAllWindows && isInternalSessionEffectsKey(row.session_key)) {
        return undefined;
      }
      const updatedAtMs = row.transcript_updated_at ?? row.updated_at;
      const current = params.currentEntries.get(row.session_key);
      // Matching identities cannot classify transcript content written before provenance existed.
      const currentIsExact = current?.sessionId === row.session_id;
      const provenanceKnown = row.session_entry_provenance === 1;
      const hookExternalContentSource =
        row.hook_external_content_source === "gmail" ||
        row.hook_external_content_source === "webhook"
          ? row.hook_external_content_source
          : undefined;
      const chatType =
        row.chat_type === "direct" || row.chat_type === "group" || row.chat_type === "channel"
          ? row.chat_type
          : undefined;
      // The legacy window class conflates email and webhook. Keep it for trust
      // gating, but report an exact source only from its bound entry or unchanged Gmail class.
      const exactHookSource =
        (currentIsExact ? current?.hookExternalContentSource : undefined) ??
        (provenanceKnown && hookExternalContentSource === "gmail" ? "gmail" : null);
      const entry: SessionEntry = {
        ...(currentIsExact && current ? structuredClone(current) : {}),
        sessionId: row.session_id,
        updatedAt: updatedAtMs,
        ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
        ...(row.spawned_by ? { spawnedBy: row.spawned_by, spawnDepth: 1 } : {}),
        ...(chatType ? { chatType } : {}),
        ...(provenanceKnown && row.plugin_owner_id ? { pluginOwnerId: row.plugin_owner_id } : {}),
        ...(provenanceKnown && hookExternalContentSource ? { hookExternalContentSource } : {}),
      };
      return {
        agentId: resolveAgentIdFromSessionKey(row.session_key, params.database.agentId),
        acpOwned: row.acp_owned === 1 || Boolean(currentIsExact && current?.acp),
        entry,
        provenanceKnown,
        sessionId: row.session_id,
        sessionKey: row.session_key,
        updatedAtMs,
        sourceMetadata: {
          createdAt: row.created_at,
          channel: row.channel,
          accountId: row.account_id,
          chatType: chatType ?? null,
          hookExternalContentSource: exactHookSource,
        },
      };
    })
    .filter((entry): entry is SessionTranscriptInstance => entry !== undefined);
}

/** Read retained archive identities through the same physical and logical session owner. */
export function listSessionTranscriptArchivesReadOnly(
  scope: Pick<SessionAccessScope, "agentId" | "env" | "storePath"> & {
    archiveNames?: readonly string[];
    sessionIds?: readonly string[];
    includeAllAgents?: boolean;
  },
) {
  const selectors = [...new Set(scope.sessionIds ?? [])];
  const archiveNames = [...new Set(scope.archiveNames ?? [])];
  if (selectors.length === 0 && archiveNames.length === 0) {
    return [];
  }
  const resolved = resolveSqliteReadScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      listTranscriptArchivesFromDatabase(
        database,
        scope.includeAllAgents ? undefined : resolved.agentId,
        selectors,
        archiveNames,
      ),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

/** Reads committed archive content before its optional filesystem export is published. */
export async function findSessionTranscriptArchiveEventReadOnly(
  scope: Pick<SessionAccessScope, "agentId" | "env" | "storePath"> & {
    sessionId?: string;
    sessionKey: string;
  },
  runId: string,
): Promise<{ event: TranscriptEvent } | undefined> {
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const context = captureOpenClawStateWorkerContext({ env: captured.env });
  const assertStateCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  const native =
    isIncognitoSessionKey(captured.sessionKey) ||
    Boolean(
      captured.storePath &&
      isIncognitoOpenClawAgentSqlitePath(captured.storePath, {
        agentId: captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey),
        env: captured.env,
      }),
    );
  const candidates = native
    ? undefined
    : captureSessionStoreReadCandidates(
        captured.storePath ??
          resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteReadScope(captured))),
      );
  const identities = new Map(
    candidates?.map(
      (candidate) =>
        [candidate.physicalPath, readDatabasePathIdentitySync(candidate.path)] as const,
    ),
  );
  const read = async (assertCurrent: () => void) => {
    const resolved = native ? resolveSqliteReadScope(captured) : await prepareSqliteScope(captured);
    assertCurrent();
    const options = toDatabaseOptions(resolved);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    const expectedIdentity = candidates
      ? identities.get(assertSessionStoreReadCandidate(databasePath, candidates))
      : undefined;
    if (candidates && !expectedIdentity) {
      throw new Error("SQLite archive database identity changed during discovery");
    }
    if (expectedIdentity) {
      const current = readDatabasePathIdentitySync(databasePath);
      if (
        current.key !== expectedIdentity.key ||
        current.birthtime !== expectedIdentity.birthtime
      ) {
        throw new Error("SQLite archive database identity changed during discovery");
      }
      if (!expectedIdentity.key.startsWith("file:")) {
        return undefined;
      }
    }
    const target = {
      logicalAgentId: resolved.agentId,
      sessionId: captured.sessionId,
      sessionKey: captured.sessionKey,
    };
    return withSqliteTranscriptArchiveSession(options, async () => {
      const readArchive = async () => {
        const [result] = await runSqliteTranscriptArchiveReadWorker([
          { agentId: options.agentId, databasePath, ...target, runId, expectedIdentity },
        ]);
        assertCurrent();
        if (expectedIdentity) {
          assertExistingDatabaseIdentity(
            databasePath,
            expectedIdentity.key,
            expectedIdentity.birthtime,
          );
        }
        return result?.event === undefined ? undefined : { event: result.event };
      };
      if (!expectedIdentity) {
        // The existing process-held store remains with its native owner until namespace migration.
        const registered = withOpenClawAgentDatabaseReadOnly(
          (database) => hasTranscriptArchiveInDatabase(database, target),
          options,
        );
        return registered.found && registered.value ? readArchive() : undefined;
      }
      const { withSessionHistoryWorkerDatabase } =
        await import("./session-transcript-worker-runtime.js");
      assertCurrent();
      return withSessionHistoryWorkerDatabase(options, async (reader) => {
        // Empty lookups never start the archive reader or retain its completion roots.
        const registered = await reader.readArchivePresence({
          ...target,
          env: captured.env,
          expectedIdentity,
        });
        assertCurrent();
        reader.assertCurrent();
        assertExistingDatabaseIdentity(
          databasePath,
          expectedIdentity.key,
          expectedIdentity.birthtime,
        );
        return registered ? readArchive() : undefined;
      });
    });
  };
  return candidates
    ? withSessionHistoryWorkerReadCandidates(candidates, (owner) =>
        read(() => {
          assertStateCurrent();
          owner.assertCurrent();
        }),
      )
    : read(assertStateCurrent);
}
