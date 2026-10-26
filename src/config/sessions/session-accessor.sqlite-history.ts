import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
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
import type { SessionAccessScope, TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
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
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Revalidate retained bytes and unique run membership before disclosing a prepared page. */
export async function verifySessionTranscriptArchivePageBindingReadOnly(
  scope: SessionAccessScope,
  runId: string,
  binding: TranscriptArchivePageBinding,
): Promise<void> {
  const result = await readSessionTaskArchivePageReadOnly(scope, { runId }, binding);
  if (!result) {
    throw new Error("Archived transcript is no longer available.");
  }
}

export async function readSessionTaskArchivePageReadOnly(
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
  if (
    isIncognitoSessionKey(captured.sessionKey) ||
    Boolean(
      captured.storePath &&
      isIncognitoOpenClawAgentSqlitePath(captured.storePath, {
        agentId: captured.agentId ?? resolveAgentIdFromSessionKey(captured.sessionKey),
        env: captured.env,
      }),
    )
  ) {
    return undefined;
  }
  const context = captureOpenClawStateWorkerContext({ env: captured.env });
  const assertStateCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  const candidates = captureSessionStoreReadCandidates(
    captured.storePath ??
      resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteReadScope(captured))),
  );
  const identities = new Map(
    candidates.map(
      (candidate) =>
        [candidate.physicalPath, readDatabasePathIdentitySync(candidate.path)] as const,
    ),
  );
  const read = async (assertCurrent: () => void) => {
    const resolved = await prepareSqliteScope(captured);
    assertCurrent();
    const options = toDatabaseOptions(resolved);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    const expectedIdentity = identities.get(
      assertSessionStoreReadCandidate(databasePath, candidates),
    );
    if (!expectedIdentity) {
      throw new Error("SQLite archive database identity changed during discovery");
    }
    const current = readDatabasePathIdentitySync(databasePath);
    if (current.key !== expectedIdentity.key || current.birthtime !== expectedIdentity.birthtime) {
      throw new Error("SQLite archive database identity changed during discovery");
    }
    if (!expectedIdentity.key.startsWith("file:")) {
      return undefined;
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
        assertExistingDatabaseIdentity(
          databasePath,
          expectedIdentity.key,
          expectedIdentity.birthtime,
        );
        return result?.event === undefined ? undefined : { event: result.event };
      };
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
  return withSessionHistoryWorkerReadCandidates(candidates, (owner) =>
    read(() => {
      assertStateCurrent();
      owner.assertCurrent();
    }),
  );
}
