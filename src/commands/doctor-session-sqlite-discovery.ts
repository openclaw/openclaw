/** Historical discovery belongs to offline Doctor, never runtime path resolution. */
import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import { collectSessionStateIdsForEntry } from "../config/sessions/session-accessor.sqlite-references.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  type MigrationArtifactIdentity,
} from "./doctor-session-sqlite-artifact.js";
import {
  canonicalMigrationFilePath,
  assertSafeSessionSqliteMigrationDirectory,
  type SessionSqliteMigrationMove,
} from "./doctor-session-sqlite-migration-run.js";
import {
  readLegacyPrimaryTranscriptIdentity,
  readTranscriptFingerprint,
  type ReadOnlySqliteValidationSnapshot,
} from "./doctor-session-sqlite-readers.js";
import { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import type { DoctorSessionSqliteIssue } from "./doctor-session-sqlite-types.js";

export const HISTORICAL_IMPORT_REASON = "indexed-historical-primary";
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
}): HistoricalArchiveSources {
  const result: HistoricalArchiveSources = new Map();
  const inventory = collectRecoveryInventory(params);
  for (const refs of inventory.references.values()) {
    if (
      refs.some(
        (ref) =>
          !ref.trusted || ref.consumedByRestore || ref.move.artifact?.disposal.state !== "retained",
      )
    ) {
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
    const first = refs[0]!;
    if (
      !refs.every(
        ({ target, move }) =>
          target.agentId === first.target.agentId &&
          target.storePath === first.target.storePath &&
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
    const sources = result.get(first.target.storePath) ?? { transcripts: [], stores: [] };
    (first.move.kind === "legacy-store" ? sources.stores : sources.transcripts).push(first.move);
    result.set(first.target.storePath, sources);
  }
  return result;
}

export async function discoverLegacyHistoricalTranscripts(params: {
  target: { agentId: string; storePath: string };
  records: readonly LegacySessionRecord[];
  ownershipRecords?: readonly LegacySessionRecord[];
  referencedPaths?: ReadonlySet<string>;
  archiveSources?: readonly SessionSqliteMigrationMove[];
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
  if (fs.existsSync(directory)) {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, item.name);
      if (
        item.isFile() &&
        isPrimarySessionTranscriptFileName(item.name) &&
        !referenced.has(canonicalMigrationFilePath(filename)) &&
        !params.referencedPaths?.has(canonicalMigrationFilePath(filename))
      ) {
        sources.set(filename, { path: filename, originalPath: filename });
      }
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
    if (records.length > 1) {
      params.issues.push({
        code: "historical_transcript_deferred",
        message: `${sessionId}: multiple primary files claim this identity; originals retained without importing`,
      });
    } else {
      discovered.push(records[0]!);
    }
  }
  return discovered;
}
