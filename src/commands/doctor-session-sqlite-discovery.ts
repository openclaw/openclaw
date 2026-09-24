/** Historical discovery belongs to offline Doctor, never runtime path resolution. */
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  isPrimarySessionTranscriptFileName,
  resolveTrajectoryPath,
  resolveTrajectoryPointerPath,
} from "../config/sessions/artifacts.js";
import {
  isLegacySessionRecordOwnedByTarget,
  listLegacySessionTranscriptFiles,
  readLegacySessionStoreEntries,
  resolveLegacyTranscriptPaths,
  shouldFilterLegacySessionRecordsByTarget,
} from "../config/sessions/legacy-store-inspection.js";
import { collectSessionStateIdsForEntry } from "../config/sessions/session-accessor.sqlite-references.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import {
  resolveAllAgentSessionStoreCandidateTargetsSync,
  type SessionStoreTarget,
} from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRealpathOrAbsolute as canonicalFilePath } from "../infra/boundary-path.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  type MigrationArtifactIdentity,
} from "../infra/session-sqlite-migration-artifact.js";
import {
  isSessionSqliteMigrationWarning,
  type DoctorSessionSqliteIssue,
} from "../infra/session-sqlite-migration-issues.js";
import {
  HISTORICAL_IMPORT_REASON,
  canonicalMigrationFilePath,
  assertSafeSessionSqliteMigrationDirectory,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import {
  readLegacyPrimaryTranscriptIdentity,
  readTranscriptFingerprint,
  type ReadOnlySqliteValidationSnapshot,
} from "../infra/session-sqlite-migration-readers.js";
import { normalizeLegacySessionEntryDelivery as normalizeSessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import { migrateLegacySessionCreator } from "../state/creator-namespace-migration.js";
import {
  collectRecoveryInventory,
  type RecoveryArtifactReference,
} from "./doctor-session-sqlite-recovery-inventory.js";

export type LegacySessionRecord = {
  entry: SessionEntry;
  sessionKey: string;
  transcriptPath?: string;
  transcriptDependencies: string[];
  recovery?: { complete: boolean; repaired: boolean; events: number };
  sourceFingerprint?: ReturnType<typeof readTranscriptFingerprint>;
  historical?: {
    originalPath: string;
    identity: MigrationArtifactIdentity;
    archiveMove?: SessionSqliteMigrationMove;
  };
};
export type HistoricalArchiveSources = Map<
  string,
  {
    transcripts: SessionSqliteMigrationMove[];
    stores: SessionSqliteMigrationMove[];
  }
>;

/** Retained manifests bind archive files to their original agent, path, and bytes. */
export function collectHistoricalArchiveSources(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  const result: HistoricalArchiveSources = new Map();
  const inventory = collectRecoveryInventory(params);
  const claims = new Map<string, RecoveryArtifactReference[][]>();
  for (const refs of inventory.references.values()) {
    if (refs.some((ref) => !ref.trusted || ref.consumedByRestore)) {
      continue;
    }
    const first = refs[0]!;
    if (
      !refs.every(
        ({ target, move }) =>
          target.agentId === first.target.agentId &&
          target.storePath === first.target.storePath &&
          target.sqlitePath === first.target.sqlitePath &&
          move.sourcePath === first.move.sourcePath,
      )
    ) {
      continue;
    }
    if (
      first.move.kind !== "legacy-store" &&
      (first.move.kind !== "unreferenced-jsonl" ||
        !isPrimarySessionTranscriptFileName(path.basename(first.move.sourcePath)))
    ) {
      continue;
    }
    if (
      !refs.every(
        ({ move }) =>
          move.artifact &&
          (move.kind === "legacy-store" || move.artifact.classification === "protected") &&
          sameMigrationArtifact(move.artifact.identity, first.move.artifact!.identity),
      )
    ) {
      continue;
    }
    if (first.move.kind === "unreferenced-jsonl") {
      const identity = first.move.artifact!.identity;
      const key = JSON.stringify([
        first.target.agentId,
        first.target.storePath,
        first.target.sqlitePath,
        first.move.sourcePath,
        identity.size,
        identity.sha256,
      ]);
      claims.set(key, [...(claims.get(key) ?? []), refs]);
    }
    if (refs.some((ref) => ref.move.artifact?.disposal.state !== "retained")) {
      continue;
    }
    // An acknowledged import stays acknowledged after explicit user deletion. Never resurrect it.
    if (
      refs.some(
        ({ target, move }) =>
          move.artifact?.reason === HISTORICAL_IMPORT_REASON &&
          target.completedMoves.some((completed) => completed.archivePath === move.archivePath),
      )
    ) {
      continue;
    }
    const sources = result.get(first.target.storePath) ?? { transcripts: [], stores: [] };
    (first.move.kind === "legacy-store" ? sources.stores : sources.transcripts).push(first.move);
    result.set(first.target.storePath, sources);
  }
  if (
    inventory.report.artifacts.some((item) =>
      ["unreadable-manifest", "manifest-directory-alias"].includes(item.reason),
    )
  ) {
    claims.clear();
  }
  return {
    sources: result,
    claims: [...claims.values()].filter((group) => group.length > 1),
    inventory,
  };
}

/** Archived registries supply lineage only; never replay their entries over live SQLite state. */
export function readArchivedSessionOwnership(
  target: SessionStoreTarget,
  stores: readonly SessionSqliteMigrationMove[],
  issues: DoctorSessionSqliteIssue[],
): LegacySessionRecord[] | undefined {
  const records: LegacySessionRecord[] = [];
  let verified = true;
  for (const move of stores) {
    if (!fs.existsSync(move.archivePath)) {
      continue;
    }
    const ownershipIssues: DoctorSessionSqliteIssue[] = [];
    try {
      if (
        !sameMigrationArtifact(
          readMigrationArtifactIdentity(move.archivePath),
          move.artifact!.identity,
        )
      ) {
        throw new Error(
          "Archived session registry no longer matches its migration receipt (file metadata or contents changed).",
        );
      }
      records.push(
        ...readLegacySessionRecords(target, ownershipIssues, { sourcePath: move.archivePath }),
      );
      if (
        ownershipIssues.length ||
        !sameMigrationArtifact(
          readMigrationArtifactIdentity(move.archivePath),
          move.artifact!.identity,
        )
      ) {
        throw new Error(
          "Archived session registry changed during verification or contains invalid entries.",
        );
      }
    } catch (error) {
      verified = false;
      issues.push({
        code: "historical_transcript_deferred",
        message:
          `${move.archivePath}: ${formatErrorMessage(error)} ` +
          "Historical transcript import skipped for this store; originals retained. " +
          "This archive warning does not indicate SQLite corruption. " +
          "No action is needed if all expected conversations are present. " +
          "If history is missing, preserve the archive and migration manifests and follow " +
          "https://docs.openclaw.ai/cli/doctor/sqlite-maintenance#changed-archived-registry",
      });
    }
  }
  return verified ? records : undefined;
}

export async function discoverLegacyHistoricalTranscripts(params: {
  target: { agentId: string; storePath: string };
  records: readonly LegacySessionRecord[];
  ownershipRecords?: readonly LegacySessionRecord[];
  referencedPaths?: ReadonlySet<string>;
  archiveSources?: readonly SessionSqliteMigrationMove[];
  verifiedSourcePaths?: ReadonlySet<string>;
  snapshot: ReadOnlySqliteValidationSnapshot;
  issues: DoctorSessionSqliteIssue[];
}): Promise<LegacySessionRecord[]> {
  const directory = path.dirname(canonicalMigrationFilePath(params.target.storePath));
  assertSafeSessionSqliteMigrationDirectory(directory);
  const sources = new Map<
    string,
    { path: string; originalPath: string; archiveMove?: SessionSqliteMigrationMove }
  >();
  const referenced = new Set(
    params.records.flatMap((record) =>
      record.transcriptPath ? [canonicalMigrationFilePath(record.transcriptPath)] : [],
    ),
  );
  for (const filename of listLegacySessionTranscriptFiles(directory)) {
    if (
      (!params.verifiedSourcePaths || params.verifiedSourcePaths.has(filename)) &&
      !referenced.has(canonicalMigrationFilePath(filename)) &&
      !params.referencedPaths?.has(canonicalMigrationFilePath(filename))
    ) {
      sources.set(filename, { path: filename, originalPath: filename });
    }
  }
  const archivedReferences = new Set(
    (params.ownershipRecords ?? []).flatMap((record) =>
      record.transcriptDependencies.map(canonicalMigrationFilePath),
    ),
  );
  for (const move of params.archiveSources ?? []) {
    // Registered aliases belong to the original importer/recovery path, not orphan discovery.
    if (archivedReferences.has(canonicalMigrationFilePath(move.sourcePath))) {
      continue;
    }
    sources.set(move.archivePath, {
      path: move.archivePath,
      originalPath: move.sourcePath,
      archiveMove: move,
    });
  }
  const owners = new Map<string, Set<string>>();
  try {
    for (const record of [...params.records, ...(params.ownershipRecords ?? [])]) {
      for (const id of collectSessionStateIdsForEntry(record.entry)) {
        const keys = owners.get(id) ?? new Set<string>();
        keys.add(record.sessionKey);
        owners.set(id, keys);
      }
    }
  } catch (error) {
    params.issues.push({
      code: "historical_transcript_deferred",
      message: `${params.target.storePath}: invalid legacy lineage; originals retained: ${String(error)}`,
    });
    return [];
  }
  const retainedSharedAliasIds = new Set(
    [...owners].filter(([, keys]) => keys.size > 1).map(([id]) => id),
  );
  const discovered: LegacySessionRecord[] = [];
  const candidates = new Map<string, LegacySessionRecord[]>();
  for (const source of sources.values()) {
    // Files are streamed individually and import runs outside the Gateway under its maintenance lock.
    await setImmediate();
    try {
      const identity = readMigrationArtifactIdentity(source.path);
      if (
        source.archiveMove &&
        !sameMigrationArtifact(identity, source.archiveMove.artifact!.identity)
      ) {
        throw new Error("Archived original changed since migration; retained without importing");
      }
      const primary = readLegacyPrimaryTranscriptIdentity(
        source.path,
        source.originalPath,
        source.archiveMove ? retainedSharedAliasIds : undefined,
      );
      if (!primary) {
        continue;
      }
      if (!sameMigrationArtifact(identity, readMigrationArtifactIdentity(source.path))) {
        throw new Error("Primary transcript changed during discovery");
      }
      if (
        params.records.some(
          (record) =>
            record.entry.sessionId === primary.sessionId &&
            record.transcriptPath &&
            fs.existsSync(record.transcriptPath),
        )
      ) {
        throw new Error(
          "A registered primary already claims this identity; extra original retained",
        );
      }
      const existingOwner = params.snapshot.sessionKeysBySessionId.get(primary.sessionId);
      const lineage = owners.get(primary.sessionId);
      if (lineage && (lineage.size !== 1 || (existingOwner && !lineage.has(existingOwner)))) {
        throw new Error("Conflicting logical owners; retained without importing");
      }
      const owner = existingOwner ?? lineage?.values().next().value;
      const pathOwner = resolveUnsuffixedSqliteTargetFromSessionStorePath(
        params.target.storePath,
      ).agentId;
      if (!owner && pathOwner !== params.target.agentId) {
        throw new Error("No unambiguous agent owner for unregistered history");
      }
      const sessionKey = owner ?? `agent:${params.target.agentId}:recovered:${primary.sessionId}`;
      const record: LegacySessionRecord = {
        sessionKey,
        entry: {
          sessionId: primary.sessionId,
          updatedAt: primary.updatedAt,
          archivedAt: primary.updatedAt || 1,
        },
        transcriptPath: source.path,
        transcriptDependencies: [source.originalPath],
        historical: {
          originalPath: source.originalPath,
          identity,
          ...(source.archiveMove ? { archiveMove: source.archiveMove } : {}),
        },
      };
      const records = candidates.get(primary.sessionId) ?? [];
      records.push(record);
      candidates.set(primary.sessionId, records);
    } catch (error) {
      params.issues.push({
        code: "historical_transcript_deferred",
        message: `${source.originalPath}: ${String(error)}`,
      });
    }
  }
  for (const [sessionId, records] of candidates) {
    const first = records[0]!;
    const identicalArchives = records.every(
      (record) =>
        record.historical?.archiveMove &&
        record.historical.originalPath === first.historical!.originalPath &&
        record.historical.identity.size === first.historical!.identity.size &&
        record.historical.identity.sha256 === first.historical!.identity.sha256,
    );
    if (records.length > 1 && !identicalArchives) {
      params.issues.push({
        code: "historical_transcript_deferred",
        message: `${sessionId}: multiple primary files claim this identity; originals retained without importing`,
      });
    } else {
      discovered.push(first);
    }
  }
  return discovered;
}

export function gatherLegacyArchiveCoverage(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  targets: readonly SessionStoreTarget[],
  knownTargets = resolveAllAgentSessionStoreCandidateTargetsSync(cfg, { env }),
) {
  const selectedStorePaths = new Set<string>();
  const referencedPaths = new Set<string>();
  const retainedPaths = new Set<string>();
  const incompleteDirectories = new Set<string>();
  const retainedDirectories = new Set<string>();
  const indexIdentities = new Map<string, MigrationArtifactIdentity>();
  const targetsByStore = new Map<string, SessionStoreTarget[]>();
  for (const target of targets) {
    const storePath = canonicalMigrationFilePath(target.storePath);
    targetsByStore.set(storePath, [...(targetsByStore.get(storePath) ?? []), target]);
  }
  const directories = new Set([...targetsByStore.keys()].map((store) => path.dirname(store)));
  const knownStores = new Map(
    [...knownTargets, ...targets].map((target) => [
      canonicalMigrationFilePath(target.storePath),
      target,
    ]),
  );
  // Only configured/discovered indexes in selected directories can contribute references.
  // An unreadable index never proves that the directory's remaining files are unreferenced.
  for (const [storePath, target] of knownStores) {
    if (
      storePath.endsWith(".sqlite") ||
      !directories.has(path.dirname(storePath)) ||
      !fs.existsSync(storePath)
    ) {
      continue;
    }
    const storeTargets = targetsByStore.get(storePath) ?? [];
    const issues: DoctorSessionSqliteIssue[] = [];
    let records: LegacySessionRecord[];
    try {
      // Aliased or unreadable known indexes cannot establish complete reference coverage.
      assertSafeSessionSqliteMigrationDirectory(path.dirname(storePath));
      indexIdentities.set(storePath, readMigrationArtifactIdentity(storePath));
      records = readLegacySessionRecords(target, issues);
    } catch (error) {
      if (storeTargets.length > 0) {
        throw error;
      }
      incompleteDirectories.add(path.dirname(storePath));
      retainedDirectories.add(path.dirname(storePath));
      continue;
    }
    const keys = [
      ...records.map((record) => record.sessionKey),
      ...issues.flatMap((issue) => (issue.sessionKey ? [issue.sessionKey] : [])),
    ];
    const selected =
      storeTargets.length > 0 &&
      issues.every(isSessionSqliteMigrationWarning) &&
      keys.every((sessionKey) =>
        storeTargets.some(
          (candidate) =>
            !shouldFilterLegacySessionRecordsByTarget(candidate) ||
            isLegacySessionRecordOwnedByTarget(cfg, candidate, sessionKey),
        ),
      );
    if (issues.length > 0) {
      incompleteDirectories.add(path.dirname(storePath));
      if (!selected) {
        retainedDirectories.add(path.dirname(storePath));
      }
    }
    if (selected) {
      selectedStorePaths.add(storePath);
    }
    for (const record of records) {
      if (!record.transcriptPath) {
        continue;
      }
      for (const source of [
        record.transcriptPath,
        resolveTrajectoryPath(record.transcriptPath),
        resolveTrajectoryPointerPath(record.transcriptPath),
      ]) {
        if (!source) {
          continue;
        }
        const canonical = canonicalMigrationFilePath(source);
        referencedPaths.add(canonical);
        if (!selected) {
          retainedPaths.add(canonical);
        }
      }
    }
  }
  for (const [storePath, storeTargets] of targetsByStore) {
    if (
      !fs.existsSync(storePath) &&
      storeTargets.every((target) => !shouldFilterLegacySessionRecordsByTarget(target))
    ) {
      selectedStorePaths.add(storePath);
    }
  }
  return {
    knownTargets,
    selectedStorePaths,
    referencedPaths,
    retainedPaths,
    incompleteDirectories,
    retainedDirectories,
    indexIdentities,
  };
}

export function readLegacySessionRecords(
  target: SessionStoreTarget,
  issues: DoctorSessionSqliteIssue[],
  options: {
    allowMissingStore?: boolean;
    sourcePath?: string;
    verifiedSourcePaths?: ReadonlySet<string>;
  } = {},
): LegacySessionRecord[] {
  const records: LegacySessionRecord[] = [];
  for (const { entry, sessionKey } of readLegacySessionStoreEntries(target, issues, options)
    .entries) {
    const { transcriptPath, transcriptDependencies } = resolveLegacyTranscriptPaths(
      target,
      entry,
      options.verifiedSourcePaths,
    );
    records.push({
      // Import repairs file-era fields before canonical SQLite readers can see them.
      entry: migrateLegacySessionCreator(normalizeSessionEntryDelivery(entry)),
      sessionKey,
      transcriptPath,
      transcriptDependencies,
    });
  }
  return records;
}

export function listUnreferencedJsonlFiles(
  storePath: string,
  referencedPaths: readonly string[],
): string[] {
  const sessionsDir = path.dirname(storePath);
  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const referenced = new Set(referencedPaths.map((filePath) => canonicalFilePath(filePath)));
  return entries
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => path.join(sessionsDir, entry))
    .filter((filePath) => !referenced.has(canonicalFilePath(filePath)))
    .toSorted((a, b) => a.localeCompare(b));
}
