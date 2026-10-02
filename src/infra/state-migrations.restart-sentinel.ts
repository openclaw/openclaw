// Doctor and restart recovery share custody of notifications written by older updaters.
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { root, type Root } from "@openclaw/fs-safe";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  parseRestartSentinelEnvelope,
  readRestartSentinelRowSync,
  readRestartSentinelSnapshotSync,
  writeRestartSentinelRowSync,
  type RestartSentinelEnvelope,
} from "./restart-sentinel-store.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import {
  MIGRATION_KIND,
  canFinalizeImportedUpdate,
  hasImportedPendingHandoff,
  hasLegacyPathWideReceipt,
  readCanonicalImport,
  readSourceDecision,
  sourceRunId,
  type RestartSentinelMigrationDecision as MigrationDecision,
} from "./state-migrations.restart-sentinel-receipts.js";
import type { LegacyRestartSentinelDetection } from "./state-migrations.restart-sentinel.types.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  type LegacyMigrationSourceSnapshot as LegacySourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "./update-control-plane-sentinel.js";

const LEGACY_RESTART_SENTINEL_FILENAME = "restart-sentinel.json";
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MAX_LEGACY_RESTART_SENTINEL_BYTES = 4 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type RestartSentinelMigrationResult = MigrationMessages & {
  importedRevision?: number;
};
/** Detect the exact retired file for startup preflight and explicit Doctor alike. */
export function detectLegacyRestartSentinel(params: {
  stateDir: string;
}): LegacyRestartSentinelDetection {
  const sourcePath = path.join(params.stateDir, LEGACY_RESTART_SENTINEL_FILENAME);
  return {
    sourcePath,
    hasLegacy: legacyMigrationSourceOrClaimMayExist(sourcePath, DOCTOR_CLAIM_SUFFIX),
  };
}

function parseLegacyEnvelope(snapshot: LegacySourceSnapshot): RestartSentinelEnvelope | null {
  try {
    return parseRestartSentinelEnvelope(JSON.parse(utf8Decoder.decode(snapshot.buffer)));
  } catch {
    return null;
  }
}

function decideAndRecordMigration(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
  envelope: RestartSentinelEnvelope | null;
  assertCurrent?: () => void;
  expectedRevision?: number | null;
}): { decision: MigrationDecision; sourceKey: string; importedRevision?: number } {
  const sourceKey = resolveLegacyMigrationSourceKey("restart-sentinel-json", params.sourcePath);
  const runId = sourceRunId(sourceKey, params.snapshot.sha256);
  const now = Date.now();
  params.assertCurrent?.();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      params.assertCurrent?.();
      const receipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
      // A path is reused for each update; retain each exact source decision across A -> B -> A.
      if (
        readSourceDecision(db, sourceKey, params.snapshot.sha256) ||
        (receipt && hasLegacyPathWideReceipt(receipt))
      ) {
        const decision: MigrationDecision = "receipt-authoritative";
        return { decision, sourceKey };
      }
      if (receipt && !receipt.sourceSha256) {
        throw new Error("restart sentinel receipt does not identify its source generation");
      }
      const { state: before, revision } = readRestartSentinelSnapshotSync(db);
      const canonicalImport =
        revision !== null
          ? readCanonicalImport(db, sourceKey, receipt?.reportJson, revision)
          : undefined;
      let decision: MigrationDecision;
      let importedRevision: number | undefined;
      const finalizesPending =
        before.kind === "valid" &&
        params.envelope &&
        canFinalizeImportedUpdate(before.sentinel, params.envelope.payload, canonicalImport);
      const handoffId = params.envelope?.payload.stats?.handoffId;
      const consumedPending =
        before.kind === "missing" &&
        handoffId &&
        hasImportedPendingHandoff(db, sourceKey, handoffId);
      if (params.expectedRevision !== undefined && revision !== params.expectedRevision) {
        throw new Error("Canonical restart state changed while the legacy notice was prepared.");
      }
      if (consumedPending) {
        decision = "canonical-advanced";
      } else if (!params.envelope) {
        decision = "malformed-legacy-discarded";
      } else if (before.kind === "valid" && !finalizesPending) {
        decision = "canonical-preserved";
      } else {
        const written = writeRestartSentinelRowSync(db, params.envelope.payload);
        importedRevision = written.revision;
        const verified = readRestartSentinelRowSync(db);
        if (
          verified.kind !== "valid" ||
          verified.sentinel.revision !== written.revision ||
          !isDeepStrictEqual(verified.sentinel.payload, params.envelope.payload)
        ) {
          throw new Error("SQLite verification failed for the restart sentinel migration");
        }
        decision = finalizesPending
          ? "legacy-update-finalized"
          : before.kind === "invalid"
            ? "invalid-canonical-repaired"
            : "legacy-imported";
      }

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: "gateway_restart_sentinel",
        decision,
        sourceSha256: params.snapshot.sha256,
        sourceValid: params.envelope !== null,
        ...(importedRevision === undefined ? {} : { importedRevision }),
        ...(importedRevision !== undefined &&
        params.envelope &&
        isPendingControlPlaneUpdateRestartSentinel(params.envelope.payload) &&
        handoffId
          ? { pendingHandoffId: handoffId }
          : {}),
        // Published path-wide receipts omitted this field; null records no generation pointer.
        ...(importedRevision === undefined ? { canonicalImport: canonicalImport ?? null } : {}),
        importedRecordCount: importedRevision === undefined ? 0 : 1,
        preservedSqliteRecordCount: decision === "canonical-preserved" ? 1 : 0,
      });
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: "gateway_restart_sentinel",
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: params.envelope ? 1 : 0,
        runId,
        now,
        reportJson,
        upsert: true,
      });
      params.assertCurrent?.();
      return { decision, sourceKey, importedRevision };
    },
    { env: params.env },
  );
}

async function recoverInterruptedClaim(params: {
  source: LegacyMigrationSourceClaim;
  env: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<void> {
  await params.source.recoverLinkedMove();
  if (!(await params.source.exists(true))) {
    return;
  }
  if (!(await params.source.exists())) {
    const restoreError = await params.source.restore();
    if (restoreError) {
      throw new Error(restoreError);
    }
    return;
  }
  // Both paths can only be retired safely when the claimed bytes already have
  // an authoritative decision; otherwise preserve both for operator recovery.
  const claimed = await params.source.read(true);
  params.assertCurrent?.();
  const decided = runOpenClawStateWriteTransaction(
    ({ db }) => {
      params.assertCurrent?.();
      return readSourceDecision(
        db,
        resolveLegacyMigrationSourceKey("restart-sentinel-json", params.source.sourcePath),
        claimed.sha256,
      );
    },
    { env: params.env },
  );
  if (!decided) {
    throw new Error("legacy restart sentinel source and interrupted claim both exist");
  }
  params.assertCurrent?.();
  await params.source.remove({ skipSourceCheck: true });
}

function decisionChange(decision: MigrationDecision): string {
  switch (decision) {
    case "legacy-imported":
      return "Imported the legacy restart sentinel into shared SQLite state.";
    case "legacy-update-finalized":
      return "Imported the final outcome of the pending legacy update.";
    case "canonical-advanced":
      return "Preserved newer canonical restart state instead of replaying legacy JSON.";
    case "invalid-canonical-repaired":
      return "Replaced an invalid SQLite restart sentinel with validated legacy state.";
    case "canonical-preserved":
      return "Preserved the canonical SQLite restart sentinel and discarded conflicting legacy JSON.";
    case "malformed-legacy-discarded":
      return "Discarded malformed retired restart sentinel JSON without importing it.";
    case "receipt-authoritative":
      return "Discarded recreated retired restart sentinel JSON using its migration receipt.";
  }
  const unreachable: never = decision;
  return unreachable;
}

export async function migrateLegacyRestartSentinelWithCustody(params: {
  detected: LegacyRestartSentinelDetection;
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
  assertCurrent?: () => void;
  expectedRevision?: number | null;
  updatesOnly?: boolean;
}): Promise<RestartSentinelMigrationResult> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const sourcePath = params.detected.sourcePath;
  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath,
    label: "restart sentinel",
    includeFilePath: false,
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacyMigrationSourceSnapshot({
        stateRoot: params.stateRoot,
        stateDir: params.stateDir,
        sourcePath: snapshotPath,
        maxBytes: MAX_LEGACY_RESTART_SENTINEL_BYTES,
        label: "restart sentinel",
      }),
  });
  try {
    await recoverInterruptedClaim({
      source,
      env: params.env,
      assertCurrent: params.assertCurrent,
    });
  } catch (error) {
    return {
      changes,
      warnings: [`Failed recovering a legacy restart sentinel Doctor claim: ${String(error)}`],
    };
  }
  if (!(await source.exists())) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await source.read();
  } catch (error) {
    return {
      changes,
      warnings: [`Failed reading the legacy restart sentinel: ${String(error)}`],
    };
  }
  const envelope = parseLegacyEnvelope(snapshot);
  if (params.updatesOnly && envelope?.payload.kind !== "update") {
    return {
      changes,
      warnings: envelope
        ? []
        : ["Legacy update notice is incomplete or invalid; its source was preserved."],
    };
  }
  try {
    params.assertCurrent?.();
    params.beforeVerify?.();
    const current = await source.read();
    if (!snapshotsMatch(current, snapshot)) {
      throw new Error("legacy restart sentinel changed after migration loaded it");
    }
    await source.claim({
      snapshot,
      mismatchMessage: "legacy restart sentinel changed before migration could claim it",
      beforeClaim: () => {
        params.assertCurrent?.();
        params.beforeClaim?.();
      },
    });
  } catch (error) {
    const restoreError = await source.restore();
    return {
      changes,
      warnings: [
        `Failed claiming the legacy restart sentinel: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  let result: ReturnType<typeof decideAndRecordMigration>;
  try {
    result = decideAndRecordMigration({
      env: params.env,
      sourcePath,
      snapshot,
      envelope,
      assertCurrent: params.assertCurrent,
      expectedRevision: params.expectedRevision,
    });
  } catch (error) {
    const restoreError = await source.restore();
    return {
      changes,
      warnings: [
        `Failed migrating the legacy restart sentinel: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    params.assertCurrent?.();
    await source.remove({
      removeSource: params.removeSource,
      sourceReappearedMessage: "legacy restart sentinel reappeared during migration cleanup",
      remainingMessage: "legacy restart sentinel remains after migration cleanup",
    });
  } catch (error) {
    warnings.push(`Legacy restart sentinel cleanup failed: ${String(error)}`);
    return { changes, warnings, importedRevision: result.importedRevision };
  }

  try {
    params.assertCurrent?.();
    markLegacyMigrationSourceRemoved(result.sourceKey, params.env, undefined, params.assertCurrent);
  } catch (error) {
    warnings.push(
      `Legacy restart sentinel was removed, but its receipt could not be finalized: ${String(error)}`,
    );
  }
  changes.push(decisionChange(result.decision));
  notices.push("Removed retired restart-sentinel.json after recording its migration decision.");
  return { changes, warnings, notices, importedRevision: result.importedRevision };
}

/** Import or retire the old file under exclusive state ownership. */
export async function migrateLegacyRestartSentinel(params: {
  detected?: LegacyRestartSentinelDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const detected = params.detected;
  if (!detected?.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "the legacy restart sentinel",
    releaseLabel: "Restart sentinel",
    errorLabel: "Failed reading the legacy restart sentinel",
    retryGuidance: "Stop the Gateway, then run `openclaw doctor --fix` again.",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_RESTART_SENTINEL_BYTES,
        symlinks: "reject",
      });
      return await migrateLegacyRestartSentinelWithCustody({
        ...params,
        detected,
        env,
        stateRoot,
      });
    },
  });
}
