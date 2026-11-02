import fs from "node:fs";
import path from "node:path";
import { extractGeneratedTranscriptSessionId } from "../config/sessions/generated-transcript-session-id.js";
import { importSqliteSessionRowsBatch } from "../config/sessions/session-accessor.sqlite-import.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
} from "./session-sqlite-migration-artifact.js";
import {
  createTranscriptEventReader,
  readLegacyPrimaryTranscriptIdentity,
  readOnlySqliteValidationSnapshot,
  readTranscriptFingerprint,
} from "./session-sqlite-migration-readers.js";
import { verifyCanonicalSessionTranscriptSources } from "./session-sqlite-transcript-verification.js";

/** An empty retained original carries no history; its backups and canonical owner must prove it. */
export async function recoverEmptyRetainedTranscript(params: {
  source: { path: string; originalPath: string };
  target: { agentId: string; storePath: string; sqlitePath: string };
  sessionIds: string[];
  env: NodeJS.ProcessEnv;
  assertCurrent: () => void;
}): Promise<string> {
  const { source, target, env } = params;
  const original = readMigrationArtifactIdentity(source.path);
  const prefix = `${path.basename(source.originalPath)}.bak-`;
  const candidates = fs
    .readdirSync(path.dirname(source.originalPath))
    .filter((name) => name.startsWith(prefix) && /^\d+-\d+$/.test(name.slice(prefix.length)))
    .map((name) => path.join(path.dirname(source.originalPath), name));
  const manual = `Preserve ${source.path} and the backup candidates (${candidates.join(", ") || `${source.originalPath}.bak-<pid>-<timestamp>: none found`}). Restore a complete verified transcript at ${source.originalPath}, then run openclaw doctor --session-sqlite recover --session-sqlite-all-agents against this same state directory. Canonical database: ${target.sqlitePath}.`;
  try {
    if (original.size !== 0) {
      throw new Error("Retained transcript is no longer empty");
    }
    const snapshot = readOnlySqliteValidationSnapshot(target);
    if (!snapshot.ok) {
      throw snapshot.error;
    }
    const filename = path.basename(source.originalPath);
    const sessionIds = params.sessionIds.length
      ? params.sessionIds
      : [extractGeneratedTranscriptSessionId(filename) ?? filename.slice(0, -".jsonl".length)];
    const backups = candidates
      .map((candidate) => ({
        path: candidate,
        identity: readMigrationArtifactIdentity(candidate),
      }))
      .toSorted((a, b) => b.identity.size - a.identity.size || a.path.localeCompare(b.path));
    for (const sessionId of sessionIds) {
      const sessionKey = snapshot.snapshot.sessionKeysBySessionId.get(sessionId);
      if (!sessionKey) {
        throw new Error(
          `No canonical session owner for ${sessionId}; deleted history was not replayed`,
        );
      }
      if (!backups.length && !snapshot.snapshot.transcriptEventCountsBySessionId.get(sessionId)) {
        throw new Error(`No backup or canonical transcript rows for ${sessionId}`);
      }
      for (const [index, backup] of backups.entries()) {
        if (
          params.sessionIds.length === 0 &&
          readLegacyPrimaryTranscriptIdentity(backup.path, source.originalPath, undefined, true)
            ?.sessionId !== sessionId
        ) {
          throw new Error(`Backup has no matching primary session identity: ${backup.path}`);
        }
        const sources = [{ path: backup.path, originalPath: source.originalPath, sessionId }];
        const verify = (mode: "contained" | "appendable") =>
          verifyCanonicalSessionTranscriptSources({ target, sources, env, mode });
        const verified = verify(index === 0 ? "appendable" : "contained");
        if (!verified || verified.events === 0) {
          throw new Error(`Backup is not covered by canonical history: ${backup.path}`);
        }
        if (verified.missingEvents) {
          const fingerprint = readTranscriptFingerprint(backup.path);
          await importSqliteSessionRowsBatch([
            {
              agentId: target.agentId,
              storePath: target.sqlitePath,
              env,
              sessionKey,
              entry: { sessionId, updatedAt: 0 },
              historicalOnly: true,
              preserveExactStoredKey: true,
              readTranscriptEvents: createTranscriptEventReader(
                backup.path,
                sessionId,
                false,
                fingerprint,
                source.originalPath,
              ),
              beforePersistentApply: () => {
                params.assertCurrent();
                const current = readOnlySqliteValidationSnapshot(target);
                if (
                  !current.ok ||
                  current.snapshot.sessionKeysBySessionId.get(sessionId) !== sessionKey ||
                  !verify("appendable")
                ) {
                  throw new Error("Canonical session owner or transcript changed before recovery");
                }
                if (
                  !sameMigrationArtifact(readMigrationArtifactIdentity(source.path), original) ||
                  !sameMigrationArtifact(
                    readMigrationArtifactIdentity(backup.path),
                    backup.identity,
                  )
                ) {
                  throw new Error("Retained transcript or backup changed before recovery");
                }
              },
            },
          ]);
          if (!verify("contained")) {
            throw new Error(`Recovered backup could not be verified: ${backup.path}`);
          }
        }
      }
    }
    if (
      !sameMigrationArtifact(readMigrationArtifactIdentity(source.path), original) ||
      backups.some(
        (backup) =>
          !sameMigrationArtifact(readMigrationArtifactIdentity(backup.path), backup.identity),
      )
    ) {
      throw new Error("Retained transcript or backup changed during recovery");
    }
    params.assertCurrent();
    return `Verified-empty retained transcript; superseded by canonical SQLite history. Backup candidates: ${candidates.join(", ") || "none"}.`;
  } catch (error) {
    throw new Error(`${String(error)}. ${manual}`, { cause: error });
  }
}
