import { resolveLegacyAuthProfileSourceCandidates } from "../agents/auth-profiles/legacy-source-files.js";
import { parseSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import {
  hasPendingSharedAuthCleanupFromDatabase,
  inspectSharedAuthLegacySourceFile,
  readSharedAuthLegacyRowsFromDatabase,
  type SharedAuthLegacyRows,
} from "../agents/auth-profiles/shared-store-bootstrap.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { inspectPluginInstallStateFromDatabase } from "../plugins/installed-plugin-index-record-state.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createRetainedAgentDatabaseMatcherFromSnapshot } from "../state/agent-deletion-discovery.js";
import { readAgentDatabaseDeletionWorkerSnapshot } from "../state/agent-deletion-journal.snapshot.worker.js";
import {
  readConfigMachineStateRowInDatabase,
  readConfigMachineStateWithMetadataInDatabase,
} from "../state/config-machine-state.js";
import { hasPersistedOpenClawAgentCanonicalValidation } from "../state/openclaw-agent-canonical-validation-receipt.js";
import {
  findOpenClawAgentDatabaseIdentity,
  isOpenClawAgentDatabasePathCurrent,
} from "../state/openclaw-agent-db-identity.js";
import {
  isOpenClawAgentReadCallbackCurrent,
  type OpenClawAgentReadOnlyDatabase,
} from "../state/openclaw-agent-db-readonly-open.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db.paths.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  openClawStateDatabaseCache,
} from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { withOpenClawStateReadOnlyLocation } from "../state/openclaw-state-db-read-connection.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sha256Hex } from "./crypto-digest.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { SqliteSnapshotCleanupError } from "./sqlite-readonly-location-cleanup.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { prepareSqliteReadOnlyLocationSync } from "./sqlite-snapshot-source.js";
import { assertExistingDatabaseIdentity } from "./sqlite-worker-identity.js";
import {
  readSharedAuthMigrationTargetRows,
  sharedAuthMigrationRowDigest,
} from "./state-migrations.shared-auth-store-codec.js";
import { inspectSharedAuthMigrationLedger } from "./state-migrations.shared-auth-store-ledger-read.js";

type InspectionPhase =
  | "admission"
  | "source-copy"
  | "state-copy"
  | "projection"
  | "cleanup"
  | "currentness";
type RefusalReason =
  | "source-callback"
  | "source-binding"
  | "source-retained"
  | "unsupported-state-version"
  | "cancelled"
  | "unavailable";
class InspectionRefusal extends Error {
  constructor(readonly reason: RefusalReason) {
    super("Artifact inspection refused");
  }
}

function rowFacts(rows: SharedAuthLegacyRows) {
  const project = (row: SharedAuthLegacyRows["store" | "state"]) => ({
    rowCount: Number(row !== null),
    sha256: sharedAuthMigrationRowDigest(row),
  });
  return { store: project(rows.store), state: project(rows.state) };
}

type ObservedFacts = {
  canonicalValidation: boolean;
  ownership: ReturnType<typeof parseSharedAuthStoreOwnership>;
  ownershipState: { present: boolean; sha256: string | null; updatedAtMs: number | null };
  source: ReturnType<typeof rowFacts>;
  target: ReturnType<typeof rowFacts>;
  legacySources: {
    kind: ReturnType<typeof resolveLegacyAuthProfileSourceCandidates>[number]["kind"];
    status: "missing" | "present";
  }[];
  pendingCleanup: boolean;
  migration: ReturnType<typeof inspectSharedAuthMigrationLedger>;
  pluginInstallState: ReturnType<typeof inspectPluginInstallStateFromDatabase>;
};
export type SharedAuthPluginArtifactInspection =
  | { status: "observed"; facts: ObservedFacts }
  | { status: "refused"; phase: InspectionPhase; reason: RefusalReason; cleanupConfirmed: boolean };

/** Observe an existing admitted callback; never open or cache another original connection. */
export function inspectSharedAuthPluginArtifactsReadOnly(
  original: OpenClawAgentReadOnlyDatabase,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): SharedAuthPluginArtifactInspection {
  const env = options.env ?? process.env;
  const ambient = getAsyncWorkSignal();
  const signal =
    options.signal && ambient
      ? AbortSignal.any([options.signal, ambient])
      : (options.signal ?? ambient);
  let phase: InspectionPhase = "admission";
  let failure: { phase: InspectionPhase; error: unknown } | undefined;
  let facts: ObservedFacts | undefined;
  let assertCurrent: (() => void) | undefined;
  const copies: PreparedSqliteReadOnlyLocation[] = [];
  try {
    signal?.throwIfAborted();
    const identity = findOpenClawAgentDatabaseIdentity(original);
    if (
      !isOpenClawAgentReadCallbackCurrent(original) ||
      !identity ||
      typeof identity.identity !== "string"
    ) {
      throw new InspectionRefusal("source-callback");
    }
    const sourcePath = resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir(env));
    const samePath = createOpenClawAgentDatabasePathMatcher();
    if (original.agentId !== "main" || !samePath(original.path, sourcePath)) {
      throw new InspectionRefusal("source-binding");
    }
    const statePath = resolveOpenClawStateSqlitePath(env);
    const admission = captureOpenClawStateDatabaseReadAdmission(statePath);
    const stateIdentity = admission.identity;
    const check = () => {
      signal?.throwIfAborted();
      if (
        !isOpenClawAgentReadCallbackCurrent(original) ||
        !isOpenClawAgentDatabasePathCurrent(original) ||
        !samePath.isCurrent()
      ) {
        throw new InspectionRefusal("source-callback");
      }
      admission.assertCurrent();
      assertExistingDatabaseIdentity(statePath, stateIdentity.key, stateIdentity.birthtime);
      openClawStateDatabaseCache.assertOpenClawStateDatabaseFreshOpenAllowedAtPath(statePath, env);
    };
    assertCurrent = check;
    check();
    phase = "source-copy";
    const sourceCopy = prepareSqliteReadOnlyLocationSync(sourcePath, {
      expectedSourceIdentity: { key: `file:${identity.identity}`, birthtime: identity.birthtime },
      signal,
    });
    copies.push(sourceCopy);
    check();
    phase = "state-copy";
    const stateCopy = prepareSqliteReadOnlyLocationSync(statePath, {
      expectedSourceIdentity: stateIdentity,
      signal,
    });
    copies.push(stateCopy);
    check();
    phase = "projection";
    facts = withOpenClawStateReadOnlyLocation(
      ({ db }) => {
        if (readStateSchemaContentVersion(db) !== OPENCLAW_STATE_SCHEMA_VERSION) {
          throw new InspectionRefusal("unsupported-state-version");
        }
        const deletion = readAgentDatabaseDeletionWorkerSnapshot(db, statePath, "maintenance");
        if (
          createRetainedAgentDatabaseMatcherFromSnapshot(
            env,
            () => [],
            deletion,
          )(sourcePath, "main")
        ) {
          throw new InspectionRefusal("source-retained");
        }
        using sourceDatabase = openNodeSqliteDatabase(sourceCopy.location, { readOnly: true });
        const ownershipRow = readConfigMachineStateRowInDatabase(db, "auth.sharedStore");
        return {
          canonicalValidation: hasPersistedOpenClawAgentCanonicalValidation(original),
          ownership: parseSharedAuthStoreOwnership(
            readConfigMachineStateWithMetadataInDatabase<unknown>(db, "auth.sharedStore")?.value,
          ),
          ownershipState: {
            present: ownershipRow !== undefined,
            sha256: ownershipRow ? sha256Hex(ownershipRow.value_json) : null,
            updatedAtMs: ownershipRow?.updated_at_ms ?? null,
          },
          source: rowFacts(readSharedAuthLegacyRowsFromDatabase(sourceDatabase)),
          target: rowFacts(readSharedAuthMigrationTargetRows(db)),
          legacySources: resolveLegacyAuthProfileSourceCandidates({ env }).map(
            ({ kind, path }) => ({ kind, status: inspectSharedAuthLegacySourceFile(path).status }),
          ),
          pendingCleanup: hasPendingSharedAuthCleanupFromDatabase(db, sourcePath),
          migration: inspectSharedAuthMigrationLedger(db, sourcePath),
          pluginInstallState: inspectPluginInstallStateFromDatabase(db),
        };
      },
      statePath,
      stateCopy.location,
    );
  } catch (error) {
    failure = { phase, error };
  }
  let cleanupConfirmed = !(failure?.error instanceof SqliteSnapshotCleanupError);
  for (const copy of copies) {
    try {
      if (!copy.cleanup()) {
        throw new InspectionRefusal("unavailable");
      }
    } catch (error) {
      cleanupConfirmed = false;
      failure ??= { phase: "cleanup", error };
    }
  }
  try {
    if (!failure) {
      assertCurrent?.();
    }
  } catch (error) {
    failure = { phase: "currentness", error };
  }
  if (failure || !facts) {
    const error = failure?.error;
    return {
      status: "refused",
      phase: failure?.phase ?? "projection",
      cleanupConfirmed,
      reason: signal?.aborted
        ? "cancelled"
        : error instanceof InspectionRefusal
          ? error.reason
          : "unavailable",
    };
  }
  return { status: "observed", facts };
}
