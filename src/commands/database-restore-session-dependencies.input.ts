import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { USER_PROFILE_ID_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { hasErrnoCode } from "../infra/errno.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { runSqliteReadOperationSync } from "../infra/sqlite-schema-facts.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { assertDatabaseArtifact, captureDatabaseArtifact } from "../snapshot/database-backup.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-schema-versions.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { requireRepositoryWorkspaceDiskAuthority } from "../state/session-repository-workspaces.authority.js";
import {
  readRetainedRecoveryRecords,
  readRetainedRecoverySource,
} from "./database-restore-session-dependencies.retained.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(4096);
const profileId = z.string().min(1).max(USER_PROFILE_ID_MAX_LENGTH);
const time = z.number().int().nonnegative();
const flag = z.union([z.literal(0), z.literal(1)]);
const requestSchema = z.strictObject({
  version: z.literal(1),
  sourceSha256: hash,
  profileId,
  agentId: z.string().min(1).max(128),
  sessionKey: text,
  sessionId: z.uuid(),
  skillId: z.uuid(),
  skillRevision: hash,
  workspaceId: z.uuid(),
  retained: z.strictObject({ expectedSha256: hash }).optional(),
});
const entrySchema = z.strictObject({
  skill_id: z.uuid(),
  owner_profile_id: profileId,
  author_profile_id: profileId,
  slug: text,
  current_revision: hash,
  shared: flag,
  enabled: flag,
  removed: flag,
  created_at: time,
  updated_at: time,
});
const revisionSchema = z.strictObject({
  skill_id: z.uuid(),
  revision: hash,
  description: z.string().max(4096),
  files_json: z.string(),
  created_at: time,
});
const workspaceSchema = z.strictObject({
  workspace_id: z.uuid(),
  agent_id: text,
  session_key: text,
  url: text,
  requested_ref: text.nullable(),
  run_setup_script: flag,
  base_commit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
  base_manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  branch: text,
  checkpoint_ref: z
    .string()
    .regex(/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u)
    .nullable(),
  manifest_hash: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .nullable(),
  revision: time,
  created_at_ms: time,
  updated_at_ms: time,
  disk_authority_json: z.string().nullable(),
});

async function captureClosedDependencyImage(file: string, expectedHash: string) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (
      await fs.lstat(file + suffix).then(
        () => true,
        (error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return false;
          }
          throw error;
        },
      )
    ) {
      throw new Error("Dependency source must be a closed single-file SQLite capture");
    }
  }
  const artifact = await captureDatabaseArtifact(file);
  if (artifact.sha256 !== expectedHash) {
    throw new Error("Dependency source checksum differs from the selected seal");
  }
  return artifact;
}

/** Fixed-layout, hash-selected input; source SQL never runs against the destination. */
export async function readSessionDependencyInput(directory: string, sha256: string) {
  const root = await fs.realpath(directory);
  await using requestFile = await fs.open(
    path.join(root, "request.json"),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  const stat = await requestFile.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) {
    throw new Error("Dependency request must be a bounded regular file");
  }
  const bytes = await requestFile.readFile();
  if (createHash("sha256").update(bytes).digest("hex") !== hash.parse(sha256)) {
    throw new Error("Dependency request checksum differs from the selected seal");
  }
  const request = requestSchema.parse(JSON.parse(bytes.toString("utf8")));
  const sourcePath = path.join(root, "shared.sqlite");
  const source = await captureClosedDependencyImage(sourcePath, request.sourceSha256);
  using db = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(sourcePath), { readOnly: true });
  const rows = runSqliteReadOperationSync(db, () => {
    const query = getNodeSqliteKysely<DB>(db);
    return {
      entry: entrySchema.parse(
        executeSqliteQueryTakeFirstSync(
          db,
          query
            .selectFrom("skill_library_entries")
            .selectAll()
            .where("skill_id", "=", request.skillId),
        ),
      ),
      revision: revisionSchema.parse(
        executeSqliteQueryTakeFirstSync(
          db,
          query
            .selectFrom("skill_library_revisions")
            .selectAll()
            .where("skill_id", "=", request.skillId)
            .where("revision", "=", request.skillRevision),
        ),
      ),
      workspace: workspaceSchema.parse(
        executeSqliteQueryTakeFirstSync(
          db,
          query
            .selectFrom("session_repository_workspaces")
            .selectAll()
            .where("workspace_id", "=", request.workspaceId),
        ),
      ),
    };
  });
  if (
    rows.entry.removed !== 0 ||
    rows.workspace.agent_id !== request.agentId ||
    rows.workspace.session_key !== request.sessionKey
  ) {
    throw new Error("Dependency source does not match the selected session owner");
  }
  if ((rows.workspace.checkpoint_ref === null) !== (rows.workspace.manifest_hash === null)) {
    throw new Error("Selected workspace has an incomplete checkpoint");
  }
  let retained;
  if (request.retained) {
    if (!rows.workspace.disk_authority_json) {
      throw new Error("Retained recovery requires the original disk authority");
    }
    const authority = requireRepositoryWorkspaceDiskAuthority(
      JSON.parse(rows.workspace.disk_authority_json),
    );
    const selection = {
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      environmentId: authority.environmentId,
    };
    if (readSqliteUserVersion(db) !== OPENCLAW_STATE_SCHEMA_VERSION) {
      throw new Error("Retained recovery requires a current-schema source image");
    }
    const original = runSqliteReadOperationSync(db, () =>
      readRetainedRecoverySource(db, selection),
    );
    const expectedPath = path.join(root, "expected.sqlite");
    const expectedArtifact = await captureClosedDependencyImage(
      expectedPath,
      request.retained.expectedSha256,
    );
    using expectedDb = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(expectedPath), {
      readOnly: true,
    });
    if (readSqliteUserVersion(expectedDb) !== OPENCLAW_STATE_SCHEMA_VERSION) {
      throw new Error("Retained recovery requires a current-schema expected image");
    }
    const expected = runSqliteReadOperationSync(expectedDb, () =>
      readRetainedRecoveryRecords(expectedDb, selection),
    );
    await assertDatabaseArtifact(expectedArtifact);
    retained = { source: original, expected };
  } else if (
    rows.workspace.disk_authority_json !== null ||
    rows.workspace.checkpoint_ref === null
  ) {
    throw new Error("Retained repository recovery requires its sealed expected owner image");
  }
  await assertDatabaseArtifact(source);
  return { root, request, rows, sourceSha256: source.sha256, retained };
}
