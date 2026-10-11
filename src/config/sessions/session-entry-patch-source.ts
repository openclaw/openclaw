import { isMainThread } from "node:worker_threads";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import { toDatabaseOptions, type ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type {
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
} from "./session-accessor.types.js";
import type { SessionEntryPatchOperation } from "./session-entry-patch-operation.js";
import type {
  SessionEntryPatchCommitObserver,
  SessionEntryPatchGuard,
  SessionEntryPatchSelection,
} from "./session-entry-patch.types.js";
import { assertCapturedSessionEntryReadSource } from "./session-entry-read-source.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SqliteSessionEntryPatchOptions = SessionEntryPatchOptions & {
  /** Exact captured writer under its caller's foreground reservation; never a new owner. */
  retainedExecution?: OpenClawAgentDatabaseExecution;
  /** Audited internal updaters: no nested writer admission; guards retain only host authority. */
  workerGuard?: SessionEntryPatchGuard;
  /** A negative current-row selection ends this internal operation before callback preparation. */
  prepareIf?: { kind: "live-model-switch-pending" };
  /** Recheck owner cancellation after async preparation, immediately before committing. */
  shouldCommit?: () => boolean;
  /** Synchronous owner bookkeeping after COMMIT, before identity observers can cancel the caller. */
  onCommitted?: SessionEntryPatchCommitObserver;
  /** Exact source acknowledged by the writer; never discover it after the operation yields. */
  onCommittedSource?: (source: CapturedSessionEntryReadSource, entry: SessionEntry) => void;
};

export type SessionEntryUpdater = (
  entry: SessionEntry,
  context: SessionEntryPatchContext,
) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null;

export type SqliteSessionEntrySnapshotPatchParams = {
  capturedSource?: CapturedSessionEntryReadSource;
  operationLabel: "session-entry.patch" | "session-entry-target.patch";
  validateCanonicalKeys: boolean;
  options: SqliteSessionEntryPatchOptions;
  selection: SessionEntryPatchSelection;
  readSnapshot: (
    database: OpenClawAgentDatabase,
    includeWindowFacts?: true,
  ) => SqliteLifecycleTargetSnapshot;
  resolved: ResolvedSqliteScope;
  sessionKey: string;
  storePath: string;
  // Callback preparation precedes BEGIN; fixed operations evaluate the transaction's current rows.
  update: SessionEntryUpdater | SessionEntryPatchOperation;
};

/** Bind entry preparation and commit checks to the original physical store before yielding. */
export function captureSessionEntryPatchSource(params: SqliteSessionEntrySnapshotPatchParams) {
  const { resolved: scope, sessionKey, capturedSource: captured, options } = params;
  const { retainedExecution } = options;
  // Queueing and either cold open must retain the same registration and lease owner.
  const resolved = {
    ...scope,
    env: cloneEnvWithPlatformSemantics(scope.env ?? process.env),
  };
  resolved.env.OPENCLAW_STATE_DIR = resolveStateDir(resolved.env);
  const databaseOptions = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const targetIdentity = readDatabasePathIdentitySync(databasePath);
  resolved.path = databasePath;
  databaseOptions.path = databasePath;
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, databaseOptions);
  const incognitoBinding = captureIncognitoSessionBinding({
    agentId: databaseOptions.agentId,
    env: resolved.env,
    sessionKey,
    storePath: databasePath,
  });
  // Released session-store callbacks retain their native synchronous transaction boundary.
  const useWorker =
    !incognitoBinding &&
    isMainThread &&
    !options.shouldCommit &&
    !options.assertCommitAllowed &&
    supportsOpenClawAgentDatabaseExecution(databaseOptions);
  const ensure = options.workerGuard?.ensureIdentitySource;
  if (
    ensure &&
    (!useWorker ||
      typeof params.update === "function" ||
      params.update.kind !== "ensure-identity" ||
      ensure.agentId !== resolved.agentId)
  ) {
    throw new Error("Transaction-local entry authority requires a closed worker ensure");
  }
  if (
    ensure &&
    (targetIdentity.key !== `file:${String(ensure.source.databaseIdentity)}` ||
      targetIdentity.birthtime !== ensure.source.databaseBirthtime)
  ) {
    throw new Error("Transaction-local entry authority differs from its writer");
  }
  const assertCapturedSource = (database?: OpenClawAgentDatabase) => {
    if (!captured) {
      return;
    }
    if (incognitoBinding) {
      const { actor } = incognitoBinding;
      actor.assertCurrent();
      if (
        captured.agentId !== actor.agentId ||
        captured.path !== actor.path ||
        captured.databaseIdentity !== actor.identity.incarnation ||
        captured.databaseBirthtime !== undefined
      ) {
        throw new Error("Captured session database changed before entry patch");
      }
      return;
    }
    if (!database && typeof captured.databaseIdentity === "string") {
      assertExistingDatabaseIdentity(
        captured.path,
        `file:${captured.databaseIdentity}`,
        captured.databaseBirthtime,
      );
    }
    assertCapturedSessionEntryReadSource(
      captured,
      database ?? getOpenClawAgentDatabaseIfOpen(databaseOptions),
    );
  };
  const assertCurrent = () => {
    if (retainedExecution) {
      retainedExecution.assertCurrent();
      const identity = retainedExecution.fileIdentity;
      if (
        !captured ||
        !identity ||
        retainedExecution.agentId !== databaseOptions.agentId ||
        captured.databaseIdentity !== identity.physicalIdentity ||
        captured.databaseBirthtime !== identity.birthtime
      ) {
        throw new Error("Retained session writer differs from its acknowledged source");
      }
    }
    if (targetIdentity.key.startsWith("file:")) {
      assertExistingDatabaseIdentity(databasePath, targetIdentity.key, targetIdentity.birthtime);
    }
    assertCapturedSource();
  };
  if (retainedExecution) {
    assertCurrent();
  }
  return {
    resolved,
    databaseOptions,
    databasePath,
    targetIdentity,
    incognito,
    incognitoBinding,
    useWorker,
    ensureIdentitySource: ensure
      ? { source: ensure.source, agentId: ensure.agentId, sessionKey: ensure.sessionKey }
      : undefined,
    assertCapturedSource,
    assertCurrent,
  };
}
