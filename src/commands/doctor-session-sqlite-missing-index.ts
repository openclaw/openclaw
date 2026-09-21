import path from "node:path";
import { isPrimarySessionTranscriptFileName } from "../config/sessions/artifacts.js";
import { listLegacySessionTranscriptFiles } from "../config/sessions/legacy-store-inspection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readMigrationArtifactIdentity,
  statMigrationPath,
} from "./doctor-session-sqlite-artifact.js";
import {
  readLegacyPrimaryTranscriptIdentity,
  readOnlySqliteDbStats,
  readOnlySqliteValidationSnapshot,
} from "./doctor-session-sqlite-readers.js";
import { collectRecoveryInventory } from "./doctor-session-sqlite-recovery-inventory.js";
import type { DoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import { verifyCanonicalSessionTranscriptSources } from "./doctor-session-sqlite-verification.js";

/** Missing index receipts describe history; only unimported transcript content requires action. */
export function createMissingSessionIndexVerifier(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}) {
  let inventory: ReturnType<typeof collectRecoveryInventory> | undefined;
  return (target: DoctorSessionSqliteTargetReport): boolean => {
    if (target.issues.length > 0) {
      return false;
    }
    try {
      if (statMigrationPath(target.storePath)) {
        return false;
      }
      inventory ??= collectRecoveryInventory(params);
      const missingIndexes = [...inventory.references.values()].filter((refs) =>
        refs.every(
          (ref) =>
            ref.trusted &&
            !ref.consumedByRestore &&
            ref.target.agentId === target.agentId &&
            ref.target.storePath === target.storePath &&
            ref.target.sqlitePath === target.sqlitePath &&
            ref.move.kind === "legacy-store" &&
            ref.move.artifact?.classification === "protected" &&
            ref.move.artifact.reason === "incomplete-index-import" &&
            ref.move.artifact.disposal.state === "retained" &&
            !statMigrationPath(ref.move.sourcePath) &&
            !statMigrationPath(ref.move.archivePath),
        ),
      );
      if (missingIndexes.length === 0) {
        return false;
      }
      const snapshot = readOnlySqliteValidationSnapshot(target);
      const stats = readOnlySqliteDbStats(target);
      if (!snapshot.ok || !stats.ok || stats.stats.integrityCheck !== "ok") {
        return false;
      }
      const sources = listLegacySessionTranscriptFiles(path.dirname(target.storePath)).map(
        (sourcePath) => {
          readMigrationArtifactIdentity(sourcePath);
          const primary = readLegacyPrimaryTranscriptIdentity(sourcePath, sourcePath);
          if (!primary || !snapshot.snapshot.sessionKeysBySessionId.has(primary.sessionId)) {
            throw new Error("Legacy transcript has no verified canonical owner");
          }
          return { path: sourcePath, sessionId: primary.sessionId };
        },
      );
      const sourcePaths = new Set(sources.map((source) => source.path));
      const dependenciesPresent = missingIndexes.every((refs) =>
        refs.every((ref) =>
          ref.move.artifact!.dependencies.every(
            (dependency) =>
              !isPrimarySessionTranscriptFileName(path.basename(dependency)) ||
              sourcePaths.has(dependency),
          ),
        ),
      );
      if (sources.length === 0 || !dependenciesPresent) {
        return false;
      }
      const verified = verifyCanonicalSessionTranscriptSources({
        target,
        sources,
        env: params.env,
      });
      if (!verified) {
        return false;
      }
      target.validatedEntries = verified.entries;
      target.validatedTranscriptEvents = verified.events;
      target.issues.push({
        code: "legacy_index_informational",
        message: `${target.storePath}: Canonical SQLite transcripts are complete. The legacy index source and archive are missing; legacy index entries are informational. No import is needed.`,
      });
      return true;
    } catch {
      // Incomplete evidence retains the existing actionable finding; it cannot certify history.
      return false;
    }
  };
}
