import fs from "node:fs/promises";
import path from "node:path";
import { ensureAbsoluteDirectory } from "../infra/fs-safe.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import {
  isCaseSensitiveDirectory,
  transcriptSessionExportKey,
  transcriptSessionSelector,
} from "./store-artifacts.js";
import { meetingTranscriptDb } from "./store-sqlite.js";

type ExportOwnershipParams = {
  session: TranscriptSessionDescriptor;
  exportRootDir: string;
  databaseOptions: OpenClawStateDatabaseOptions;
};

function database(options: OpenClawStateDatabaseOptions) {
  ensureMeetingTranscriptsSchema(options);
  return openOpenClawStateDatabase(options);
}

export async function assertTranscriptExportPathAvailable(
  params: ExportOwnershipParams,
): Promise<void> {
  const stateDatabase = database(params.databaseOptions);
  const collisions = executeSqliteQuerySync(
    stateDatabase.db,
    meetingTranscriptDb(stateDatabase.db)
      .selectFrom("meeting_transcript_sessions")
      .select(["session_id", "started_at", "selector", "export_pending_json"])
      .where("export_key", "=", transcriptSessionExportKey(params.session))
      .orderBy("selector", "asc"),
  ).rows;
  if (collisions.length <= 1) {
    return;
  }
  const ensured = await ensureAbsoluteDirectory(params.exportRootDir, {
    mode: 0o700,
    scopeLabel: "transcript export root",
  });
  if (!ensured.ok) {
    throw ensured.error;
  }
  if (await isCaseSensitiveDirectory(params.exportRootDir)) {
    return;
  }
  let ownerSelector: string | undefined;
  try {
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(params.exportRootDir, collisions[0]!.selector, "metadata.json"),
        "utf8",
      ),
    ) as { sessionId?: unknown; startedAt?: unknown };
    ownerSelector = collisions.find(
      (row) => row.session_id === metadata.sessionId && row.started_at === metadata.startedAt,
    )?.selector;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  if (!ownerSelector) {
    const pendingOwners = collisions.filter((row) =>
      (JSON.parse(row.export_pending_json) as string[]).includes("metadata.json"),
    );
    if (pendingOwners.length === 1) {
      ownerSelector = pendingOwners[0]?.selector;
    }
  }
  ownerSelector ??= transcriptSessionSelector(params.session);
  if (ownerSelector !== transcriptSessionSelector(params.session)) {
    throw new Error(
      `transcript export path collides case-insensitively with another session: ${path.join(params.exportRootDir, transcriptSessionSelector(params.session))}`,
    );
  }
}

export async function hasAliasedCanonicalTranscriptExportPathOwner(
  params: ExportOwnershipParams,
): Promise<boolean> {
  const stateDatabase = database(params.databaseOptions);
  const owner = executeSqliteQueryTakeFirstSync(
    stateDatabase.db,
    meetingTranscriptDb(stateDatabase.db)
      .selectFrom("meeting_transcript_sessions")
      .select("session_id")
      .where("export_key", "=", transcriptSessionExportKey(params.session))
      .limit(1),
  );
  if (!owner) {
    return false;
  }
  try {
    await fs.access(params.exportRootDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  return !(await isCaseSensitiveDirectory(params.exportRootDir));
}
