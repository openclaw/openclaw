// Doctor-only import for the retired exec approvals JSON store.
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok } from "@openclaw/normalization-core/result";
import { z } from "zod";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { runClientCredentialOperation } from "./client-credential-store.js";
import {
  normalizeExecApprovalsInternal,
  parseLegacyExecApprovals,
  resolveExecApprovalsPath,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile } from "./exec-approvals-core.js";
import { ExecApprovalsMigrationRequiredError } from "./exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { pathMayExistSync } from "./path-existence.js";
import type { EngineConnection } from "./sql-connection.js";
import {
  hasLegacySqliteExecApprovals,
  repairLegacySqliteExecApprovals,
} from "./state-migrations.exec-approvals-canonical.js";
import type { LegacyExecApprovalsDetection } from "./state-migrations.exec-approvals.types.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import { inspectLegacyMigrationLinkedMove } from "./state-migrations.no-replace-move.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist,
  readLegacyMigrationSourceSnapshot,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

export const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
export const MAX_LEGACY_EXEC_APPROVALS_BYTES = 4 * 1024 * 1024;
const MIGRATION_KIND = "legacy-exec-approvals-json";
const TARGET_TABLE = "exec_approvals_config";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type LegacySourceSnapshot = Omit<LegacyMigrationSourceSnapshot, "raw"> & { raw: string | null };

// Only the observed policy-free stub may omit its version. Unknown fields or
// nonempty policy are not proof that a legacy file is safe to retire.
const emptyLegacyExecApprovalsSchema = z.strictObject({
  version: z.literal(1).optional(),
  defaults: z.strictObject({}),
  agents: z.strictObject({}),
  socket: z.strictObject({ path: z.string().optional(), token: z.string().optional() }).optional(),
});

type ArchivedEmptyLegacy = { file: ExecApprovalsFile; archivePath: string };

type MigrationDecision =
  | "empty-legacy-retired"
  | "canonical-preserved"
  | "invalid-canonical-repaired"
  | "legacy-imported"
  | "malformed-legacy-preserved"
  | "receipt-authoritative";

type LegacyExecApprovalsFacts = {
  canonical: ReturnType<typeof readExecApprovalsConfigRow>;
  receipt: LegacyMigrationReceipt | null;
};

/** Read the selected predecessor once with the caller's admitted shared-state snapshot. */
export function readLegacyExecApprovalsPreparationFacts(
  database: EngineConnection,
  sourcePath: string,
): LegacyExecApprovalsFacts {
  return {
    canonical: tableExists(database, TARGET_TABLE)
      ? readExecApprovalsConfigRow(database)
      : undefined,
    receipt: tableExists(database, "migration_sources")
      ? readLegacyMigrationReceiptFromDatabase(
          database,
          resolveLegacyMigrationSourceKey("exec-approvals-json", sourcePath),
        )
      : null,
  };
}

function normalizeLegacyNullableUsageMetadata(raw: string): string {
  const parsed = safeParseJsonRecord(raw);
  if (!parsed || !isRecord(parsed.agents)) {
    return raw;
  }

  let changed = false;
  for (const agent of Object.values(parsed.agents)) {
    if (!isRecord(agent) || !Array.isArray(agent.allowlist)) {
      continue;
    }
    for (const entry of agent.allowlist) {
      if (!isRecord(entry)) {
        continue;
      }
      // Legacy files can contain null usage metadata. Repair only these fields at
      // import so canonical policy validation remains strict.
      for (const key of ["lastUsedAt", "lastUsedCommand"]) {
        if (entry[key] === null) {
          delete entry[key];
          changed = true;
        }
      }
    }
  }
  return changed ? JSON.stringify(parsed) : raw;
}

/** Detect retired approvals only when an explicit Doctor flow opts in. */
export function detectLegacyExecApprovals(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyExecApprovalsDetection {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sourcePath = resolveExecApprovalsPath(env);
  const sourcePresent = legacyMigrationSourceOrClaimMayExist(sourcePath, DOCTOR_CLAIM_SUFFIX);
  return {
    sourcePath,
    preview: "- Exec approvals: normalize legacy policy into canonical SQLite state",
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      (sourcePresent || hasLegacySqliteExecApprovals(env)),
  };
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
): Promise<LegacySourceSnapshot> {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
    label: "exec approvals",
  });
  return decodeLegacySourceSnapshot(snapshot);
}

function decodeLegacySourceSnapshot(snapshot: LegacyMigrationSourceSnapshot): LegacySourceSnapshot {
  let raw: string | null = null;
  try {
    raw = utf8Decoder.decode(snapshot.buffer);
  } catch {
    // Invalid UTF-8 is malformed input that must stay available for recovery.
  }
  return { ...snapshot, raw };
}

function emptyLegacyFile(snapshot: LegacySourceSnapshot): ExecApprovalsFile | undefined {
  const parsed = emptyLegacyExecApprovalsSchema.safeParse(
    snapshot.raw === null ? null : safeParseJsonRecord(snapshot.raw),
  );
  return parsed.success
    ? normalizeExecApprovalsInternal({ ...parsed.data, version: 1 })
    : undefined;
}

function decideLegacyExecApprovals(
  params: LegacyExecApprovalsFacts & {
    snapshot: LegacySourceSnapshot;
    emptyStub?: ExecApprovalsFile;
  },
) {
  const legacy = params.emptyStub
    ? ok<ExecApprovalsFile, string>(params.emptyStub)
    : params.snapshot.raw === null
      ? err<never, string>("invalid UTF-8 encoding")
      : parseLegacyExecApprovals(normalizeLegacyNullableUsageMetadata(params.snapshot.raw));
  const legacyFile = legacy.ok ? legacy.value : null;
  const canonicalPolicy = params.canonical
    ? parseLegacyExecApprovals(params.canonical.raw_json)
    : null;
  const canonicalFile = canonicalPolicy?.ok ? canonicalPolicy.value : null;
  let receiptImportedSameSource = false;
  if (params.receipt?.sourceSha256 === params.snapshot.sha256) {
    try {
      const report = JSON.parse(params.receipt.reportJson) as { decision?: unknown };
      receiptImportedSameSource =
        report.decision === "legacy-imported" ||
        report.decision === "invalid-canonical-repaired" ||
        report.decision === "receipt-authoritative";
    } catch {
      // A malformed receipt is not authority to discard security state.
    }
  }
  let decision: MigrationDecision;
  let removeSource = false;
  if (
    params.emptyStub &&
    (params.canonical || (!legacyFile?.socket?.path && !legacyFile?.socket?.token))
  ) {
    decision = "empty-legacy-retired";
    removeSource = true;
  } else if (!legacyFile || params.snapshot.raw === null) {
    decision = "malformed-legacy-preserved";
  } else if (receiptImportedSameSource && canonicalFile) {
    decision = "receipt-authoritative";
    removeSource = true;
  } else if (!params.canonical || !canonicalFile) {
    decision = params.canonical ? "invalid-canonical-repaired" : "legacy-imported";
    removeSource = true;
  } else {
    decision = "canonical-preserved";
    removeSource = params.canonical.raw_json === params.snapshot.raw;
  }
  return { legacy, legacyFile, decision, removeSource };
}

/** Validate both interrupted names without claiming, archiving, or recording a decision. */
export async function prepareLegacyExecApprovals(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  facts?: LegacyExecApprovalsFacts;
}): Promise<void> {
  const sourcePath = resolveExecApprovalsPath(params.env);
  const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  if (!pathMayExistSync(sourcePath) && !pathMayExistSync(claimPath)) {
    return;
  }
  try {
    const stateRoot = await root(params.stateDir, {
      hardlinks: "reject",
      maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
      symlinks: "reject",
    });
    const sourceRelative = path.relative(params.stateDir, sourcePath);
    const claimRelative = path.relative(params.stateDir, claimPath);
    const linked = await inspectLegacyMigrationLinkedMove(stateRoot, sourceRelative, claimRelative);
    const snapshots: LegacySourceSnapshot[] = [];
    if (linked) {
      const opened = await stateRoot.read(sourceRelative, {
        hardlinks: "allow",
        maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
        symlinks: "reject",
      });
      const current = await inspectLegacyMigrationLinkedMove(
        stateRoot,
        sourceRelative,
        claimRelative,
      );
      if (
        !current ||
        current.dev !== linked.dev ||
        current.ino !== linked.ino ||
        opened.exactIdentity.dev !== linked.dev ||
        opened.exactIdentity.ino !== linked.ino
      ) {
        throw new Error("Legacy exec approvals source/claim link pair changed.");
      }
      snapshots.push(
        decodeLegacySourceSnapshot({
          buffer: opened.buffer,
          dev: opened.exactIdentity.dev,
          ino: opened.exactIdentity.ino,
          mtimeMs: opened.stat.mtimeMs,
          raw: opened.buffer.toString("utf8"),
          sha256: createHash("sha256").update(opened.buffer).digest("hex"),
          size: opened.buffer.byteLength,
          sourcePath,
        }),
      );
    } else {
      for (const candidate of [sourcePath, claimPath]) {
        if (await stateRoot.exists(path.relative(params.stateDir, candidate))) {
          snapshots.push(await readLegacySourceSnapshot(stateRoot, params.stateDir, candidate));
        }
      }
    }
    const snapshot = snapshots[0];
    if (!snapshot) {
      return;
    }
    if (snapshots.some((other) => other.sha256 !== snapshot.sha256)) {
      throw new Error("Legacy exec approvals source and interrupted claim disagree.");
    }
    const decision = decideLegacyExecApprovals({
      ...(params.facts ?? { canonical: undefined, receipt: null }),
      snapshot,
      emptyStub: emptyLegacyFile(snapshot),
    });
    if (!decision.removeSource) {
      throw new Error(
        decision.legacy.ok
          ? "Conflicting legacy exec approvals remain"
          : `Invalid legacy exec approvals (${decision.legacy.error})`,
      );
    }
  } catch (error) {
    throw new ExecApprovalsMigrationRequiredError(sourcePath, "doctor", String(error), params.env);
  }
}

function decideAndRecordMigration(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
  emptyStub?: ArchivedEmptyLegacy;
}): { message: string; removeSource: boolean; sourceKey: string } {
  const sourceKey = resolveLegacyMigrationSourceKey("exec-approvals-json", params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const canonical = readExecApprovalsConfigRow(db);
      const { legacy, legacyFile, decision, removeSource } = decideLegacyExecApprovals({
        canonical,
        receipt: readLegacyMigrationReceiptFromDatabase(db, sourceKey),
        snapshot: params.snapshot,
        emptyStub: params.emptyStub?.file,
      });
      if (
        legacyFile &&
        (decision === "legacy-imported" || decision === "invalid-canonical-repaired")
      ) {
        // First-writer-wins preserves a socket issued during an interrupted import.
        if (legacyFile.socket?.path || legacyFile.socket?.token) {
          runClientCredentialOperation(params.env, {
            kind: "socket.ensure",
            fallback: {
              socket_key: "current",
              socket_path: legacyFile.socket.path ?? null,
              socket_token: legacyFile.socket.token ?? null,
              updated_at_ms: now,
            },
          });
        }
        writeExecApprovalsConfigRow({
          db,
          file: legacyFile,
          raw: serializeExecApprovals(legacyFile),
          now,
        });
      }

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: TARGET_TABLE,
        decision,
        sourceSha256: params.snapshot.sha256,
        sourceValid: legacyFile !== null,
        ...(params.emptyStub ? { archivePath: params.emptyStub.archivePath } : {}),
        importedRecordCount:
          decision === "legacy-imported" || decision === "invalid-canonical-repaired" ? 1 : 0,
        preservedSqliteRecordCount:
          canonical &&
          decision !== "legacy-imported" &&
          decision !== "invalid-canonical-repaired" &&
          decision !== "malformed-legacy-preserved"
            ? 1
            : 0,
        removesSource: removeSource,
      });
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: TARGET_TABLE,
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: legacyFile && decision !== "empty-legacy-retired" ? 1 : 0,
        runId,
        now,
        reportJson,
        upsert: true,
      });
      const message = removeSource
        ? decisionMessages[decision]
        : legacy.ok
          ? "Conflicting legacy exec approvals remain"
          : `Invalid legacy exec approvals (${legacy.error})`;
      return { message, removeSource, sourceKey };
    },
    { env: params.env },
    { operationLabel: "state-migration.exec-approvals" },
  );
}

const decisionMessages: Record<MigrationDecision, string> = {
  "empty-legacy-retired": "Archived empty legacy exec approvals without changing SQLite policy.",
  "legacy-imported": "Imported legacy exec approvals policy and local socket credentials.",
  "invalid-canonical-repaired":
    "Replaced an invalid SQLite exec approvals row with validated legacy state.",
  "canonical-preserved": "Preserved byte-identical canonical SQLite exec approvals.",
  "malformed-legacy-preserved": "Preserved malformed legacy exec approvals for operator recovery.",
  "receipt-authoritative": "Completed cleanup for previously imported legacy exec approvals.",
};

async function migrateWithExclusiveStateOwnership(params: {
  detected: LegacyExecApprovalsDetection;
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const sourcePath = params.detected.sourcePath;
  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath,
    label: "exec approvals",
    includeFilePath: false,
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacySourceSnapshot(params.stateRoot, params.stateDir, snapshotPath),
  });
  try {
    await source.recover("legacy exec approvals source and interrupted claim both exist");
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed recovering a legacy exec approvals Doctor claim: ${String(error)}`],
    };
  }
  if (!(await source.exists())) {
    return { changes: [], warnings: [] };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await source.read();
  } catch (error) {
    return { changes: [], warnings: [`Failed reading legacy exec approvals: ${String(error)}`] };
  }

  try {
    await source.verify(snapshot, "legacy exec approvals changed after migration loaded them");
    await source.claim({
      snapshot,
      mismatchMessage: "legacy exec approvals changed before migration could claim them",
    });
  } catch (error) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `Failed claiming legacy exec approvals: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  let result: ReturnType<typeof decideAndRecordMigration>;
  let emptyStub: ArchivedEmptyLegacy | undefined;
  try {
    const file = emptyLegacyFile(snapshot);
    if (file) {
      const archiveSuffix = `.migrated.${snapshot.sha256}.${randomUUID()}`;
      const archivePath = `${sourcePath}${archiveSuffix}`;
      // Keep exact bytes before retirement; a fresh no-clobber backup lets retries
      // recover even when an earlier archive write was interrupted.
      await params.stateRoot.create(
        `${source.sourceRelativePath}${archiveSuffix}`,
        snapshot.buffer,
        { mode: 0o600 },
      );
      const archived = await readLegacySourceSnapshot(
        params.stateRoot,
        params.stateDir,
        archivePath,
      );
      if (archived.sha256 !== snapshot.sha256) {
        throw new Error("legacy exec approvals archive differs from the claimed source");
      }
      emptyStub = {
        archivePath,
        file,
      };
    }
    result = decideAndRecordMigration({
      env: params.env,
      sourcePath,
      snapshot,
      emptyStub,
    });
  } catch (error) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy exec approvals: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  if (!result.removeSource) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `${result.message}${restoreError ? ` Claim restore failed: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    await source.remove({
      sourceReappearedMessage: "legacy exec approvals reappeared during migration cleanup",
      remainingMessage: "legacy exec approvals remain after migration cleanup",
    });
  } catch (error) {
    return {
      changes: [],
      warnings: [`Legacy exec approvals cleanup failed: ${String(error)}`],
    };
  }

  const warnings: string[] = [];
  try {
    markLegacyMigrationSourceRemoved(
      result.sourceKey,
      params.env,
      "state-migration.exec-approvals.receipt",
    );
  } catch (error) {
    warnings.push(
      `Legacy exec approvals were removed, but their receipt could not be finalized: ${String(error)}`,
    );
  }
  return {
    changes: [result.message],
    warnings,
    notices: [
      ...(emptyStub ? [`Archived empty legacy exec approvals at ${emptyStub.archivePath}.`] : []),
      "Removed retired exec approvals JSON after recording its migration decision.",
    ],
  };
}

/** Import or retire the old file under exclusive state ownership. */
export async function migrateLegacyExecApprovals(params: {
  detected?: LegacyExecApprovalsDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const detected = params.detected;
  if (!detected?.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  let canonicalRepair: MigrationMessages = { changes: [], warnings: [] };
  const result = await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy exec approvals",
    releaseLabel: "Exec approvals",
    errorLabel: "Failed reading legacy exec approvals",
    retryGuidance: `Stop the Gateway and node hosts holding ${params.stateDir}.`,
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
        symlinks: "reject",
      });
      const legacyResult = await migrateWithExclusiveStateOwnership({
        ...params,
        detected,
        env,
        stateRoot,
      });
      canonicalRepair = await repairLegacySqliteExecApprovals(env);
      return legacyResult;
    },
  });
  if (result.changes.length > 0) {
    return {
      ...result,
      changes: [...canonicalRepair.changes, ...result.changes],
      notices: [...(canonicalRepair.notices ?? []), ...(result.notices ?? [])],
    };
  }
  const retainedPaths = [
    detected.sourcePath,
    `${detected.sourcePath}${DOCTOR_CLAIM_SUFFIX}`,
  ].filter(pathMayExistSync);
  return {
    ...result,
    changes: canonicalRepair.changes,
    notices: [...(canonicalRepair.notices ?? []), ...(result.notices ?? [])],
    warnings: result.warnings.map(
      (problem) =>
        new ExecApprovalsMigrationRequiredError(
          retainedPaths.join(", ") || detected.sourcePath,
          "doctor",
          problem,
        ).message,
    ),
  };
}
