import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  isPrimarySessionTranscriptFileName,
  isTrajectorySessionArtifactName,
} from "../config/sessions/artifacts.js";
import { extractGeneratedTranscriptSessionId } from "../config/sessions/generated-transcript-session-id.js";
import { readLegacySessionStoreEntries } from "../config/sessions/legacy-store-inspection.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  collectArchivedSources,
  existingSessionSourcePaths,
} from "./deferred-plugin-session-artifacts.js";
import {
  readDeferredPluginSessionImportReceipt,
  resolveVerifiedSessionSource,
  type SessionImportSource,
} from "./deferred-plugin-session-sources.js";
import {
  databaseIdentity,
  preservesRecordedIndexValue,
  sameSourceContent,
  verifyDeferredSessionDatabase,
  verifyMissingDeferredSessionTranscript,
} from "./deferred-plugin-session-verification.js";
import {
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  statMigrationPath,
} from "./session-sqlite-migration-artifact.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import {
  parseSessionImportReceipt,
  supersedeDeferredPluginSessionImport,
  type DeferredPluginSessionImport,
} from "./state-migrations.deferred-session-import.js";
import type { LegacyMigrationReceipt } from "./state-migrations.receipts.js";

/** Rebuild derived evidence from proven original index values or verified canonical transcripts. */
export async function rebuildDeferredPluginSessionSourceIndex(
  params: SessionImportSource & {
    onSourceConflict?: (sourcePath: string, artifactPath?: string, error?: unknown) => void;
    onEmptySource?: (sourcePath: string, reason: string) => void;
    onMissingSource?: (sourcePath: string, reason: string) => void;
  },
): Promise<boolean> {
  const receipt = readDeferredPluginSessionImportReceipt(params);
  if (!receipt) {
    return false;
  }
  const { recorded, currentDatabaseIdentity, physicalIdentity, stale } = parseSessionImportReceipt(
    params,
    receipt,
  );
  if (recorded.superseded) {
    return false;
  }
  if (stale) {
    supersedeDeferredPluginSessionImport({
      receipt,
      databaseIdentity: currentDatabaseIdentity,
      sqlitePath: params.sqlitePath,
      physicalIdentity,
      env: params.env,
    });
    return true;
  }
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const index = recorded.sources.find((source) => source.path === path.resolve(target.storePath));
  let verifiedIndex = index;
  const archives = collectArchivedSources(target, params.env);
  const verifiedSourcePaths = new Set(recorded.sources.map((source) => source.path));
  const missingIndex =
    index && existingSessionSourcePaths(index.path, target, params.env, archives).length === 0;
  const receiptStillBound = (current: LegacyMigrationReceipt | null | undefined) =>
    isDeepStrictEqual(current, receipt) &&
    databaseIdentity(params.sqlitePath, "physical") === physicalIdentity &&
    databaseIdentity(params.sqlitePath) === currentDatabaseIdentity;
  const assertCurrent = () => {
    if (
      !receiptStillBound(readDeferredPluginSessionImportReceipt(params)) ||
      (verifiedIndex &&
        !missingIndex &&
        !resolveVerifiedSessionSource(verifiedIndex, target, params.env, new Map())) ||
      (missingIndex && existingSessionSourcePaths(index.path, target, params.env).length > 0)
    ) {
      throw new Error(
        "Retained session receipt, index, or database changed during recovery; sources remain protected.",
      );
    }
  };
  const sources: DeferredPluginSessionImport["sources"] = [];
  const settledSources = [...(recorded.settledSources ?? [])];
  for (const source of recorded.sources.filter(
    (item) =>
      (!missingIndex || item !== index) &&
      (!isTrajectorySessionArtifactName(path.basename(item.path)) ||
        existingSessionSourcePaths(item.path, target, params.env, archives).length > 0),
  )) {
    if (
      isPrimarySessionTranscriptFileName(path.basename(source.path)) &&
      existingSessionSourcePaths(source.path, target, params.env, archives).length === 0 &&
      (await verifyMissingDeferredSessionTranscript({
        target,
        env: params.env,
        identity: source.identity,
        sessionId:
          extractGeneratedTranscriptSessionId(source.path) ?? path.basename(source.path, ".jsonl"),
      }))
    ) {
      settledSources.push({
        ...source,
        reason:
          "Missing original satisfied by an exact size and SHA-256 match of canonical SQLite history; no events replayed.",
      });
      continue;
    }
    sources.push(
      await (async () => {
        let failure: unknown;
        const candidates = statMigrationPath(source.path)
          ? [source.path]
          : (archives.get(source.path) ?? []).map((archive) => archive.path);
        for (const candidate of candidates) {
          if (!statMigrationPath(candidate)) {
            continue;
          }
          try {
            const identity = readMigrationArtifactIdentity(candidate);
            const emptyTranscript =
              identity.size === 0 && isPrimarySessionTranscriptFileName(path.basename(source.path));
            if (
              (!emptyTranscript ||
                (candidate !== source.path &&
                  currentDatabaseIdentity === recorded.databaseIdentity)) &&
              sameSourceContent(identity, source.identity)
            ) {
              return { path: source.path, identity };
            }
            if (
              (!emptyTranscript && candidate !== source.path) ||
              (source.path !== path.resolve(target.storePath) &&
                !isPrimarySessionTranscriptFileName(path.basename(source.path)))
            ) {
              continue;
            }
            const isIndex = source.path === path.resolve(target.storePath);
            const indexPath =
              !isIndex &&
              verifiedIndex &&
              // Recovery yields between sources; do not reuse verification across those awaits.
              resolveVerifiedSessionSource(verifiedIndex, target, params.env, new Map());
            if (isIndex) {
              const issues: Array<{ code: string; message: string }> = [];
              const current = readLegacySessionStoreEntries(params.target, issues, {
                sourcePath: candidate,
              });
              if (!current.bytes || !preservesRecordedIndexValue(current.bytes, source.identity)) {
                throw new Error(
                  `Cannot prove the retained index preserves its original entries, metadata, and transcript links: ${candidate}. ${issues.map((issue) => issue.message).join("; ")}`,
                );
              }
            } else {
              if (!emptyTranscript && (!indexPath || !verifiedIndex)) {
                throw new Error(
                  "Changed transcript has no verified retained index to establish its session owner.",
                );
              }
              await verifyDeferredSessionDatabase({
                ...params,
                sources: [
                  ...(verifiedIndex && indexPath
                    ? [{ originalPath: verifiedIndex.path, path: indexPath }]
                    : []),
                  { originalPath: source.path, path: candidate },
                ],
                requireCompleteTranscript: true,
                verifiedSourcePaths,
                assertCurrent,
              });
            }
            if (
              !sameMigrationArtifact(readMigrationArtifactIdentity(candidate), identity) ||
              (indexPath &&
                verifiedIndex &&
                !sameSourceContent(
                  readMigrationArtifactIdentity(indexPath),
                  verifiedIndex.identity,
                ))
            ) {
              continue;
            }
            if (isIndex) {
              verifiedIndex = { path: source.path, identity };
            }
            return { path: source.path, identity };
          } catch (error) {
            if (
              statMigrationPath(candidate)?.size === 0 &&
              isPrimarySessionTranscriptFileName(path.basename(source.path))
            ) {
              throw error;
            }
            // An unreadable or aliased source remains protected with its recorded identity.
            failure = error;
          }
        }
        if (failure !== undefined) {
          params.onSourceConflict?.(source.path, undefined, failure);
        }
        // Unverified content retains its old receipt until Doctor protects the current artifact.
        return source;
      })(),
    );
  }
  const rebuilt = {
    ...recorded,
    databaseIdentity: currentDatabaseIdentity,
    sources,
    ...(settledSources.length ? { settledSources } : {}),
  };
  if (isDeepStrictEqual(rebuilt, recorded)) {
    return false;
  }
  const context = captureOpenClawStateWorkerContext({ env: params.env });
  await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "deferredSessionImport.rebuildSources",
        input: {
          receipt,
          rebuilt,
          storePath: target.storePath,
          sqlitePath: params.sqlitePath,
          physicalIdentity,
        },
      }),
    {
      createAdmission: createSqliteWorkerWriteAdmission(context.admission.assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
  for (const source of settledSources.slice(recorded.settledSources?.length ?? 0)) {
    params.onMissingSource?.(source.path, source.reason);
  }
  return true;
}
